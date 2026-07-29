import asyncio
import array
import importlib.util
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SERVER_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "local-realtime"
    / "server.py"
)
TORCH_BACKEND_PATH = SERVER_PATH.with_name("tts_qwen3_torch.py")
EVALUATOR_PATH = SERVER_PATH.with_name("evaluate_qwen_streaming.py")


def _load_evaluator():
    spec = importlib.util.spec_from_file_location("kxyy_qwen_stream_evaluator", EVALUATOR_PATH)
    evaluator = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = evaluator
    spec.loader.exec_module(evaluator)
    return evaluator


evaluator = _load_evaluator()


def _load_server():
    fake_common = types.ModuleType("common")
    fake_common.OUTPUT_RATE = 24000
    fake_common._mlx_pool = None
    fake_common._synth_tts_stream = None
    fake_common.ensure_ref_wav = lambda: (Path("/fake/ref.wav"), "reference")
    fake_common.load_settings = lambda: {}
    fake_common.log = lambda _message: None
    fake_common.load_whisper_on_mlx_thread = lambda: None
    fake_common.text_for_speech = lambda text: text
    fake_common.clip_speech_text = lambda text: text.strip()
    fake_common.chunk_pcm = lambda pcm, _milliseconds: (pcm,)
    fake_common.pcm16_rms = lambda pcm: (
        sum((sample / 32768.0) ** 2 for sample in array.array("h", pcm))
        / max(1, len(pcm) // 2)
    ) ** 0.5
    fake_common.pcm16_to_browser_wav = lambda pcm, _rate: pcm
    fake_common.REPO = Path("/fake/repo")
    fake_common.run = lambda **_kwargs: None
    fake_capability = types.SimpleNamespace(
        status="disabled",
        mode="disabled",
        pipeline_factory=lambda: None,
    )
    fake_silero = types.SimpleNamespace(
        capability_from_environment=lambda: fake_capability
    )

    spec = importlib.util.spec_from_file_location("kxyy_qwen_mlx_server", SERVER_PATH)
    server = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    previous_common = sys.modules.get("common")
    previous_silero = sys.modules.get("silero_shadow")
    sys.modules["common"] = fake_common
    sys.modules["silero_shadow"] = fake_silero
    try:
        spec.loader.exec_module(server)
    finally:
        if previous_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = previous_common
        if previous_silero is None:
            sys.modules.pop("silero_shadow", None)
        else:
            sys.modules["silero_shadow"] = previous_silero
    return server, fake_common


server, common = _load_server()


def _load_torch_backend():
    spec = importlib.util.spec_from_file_location(
        "kxyy_qwen_torch_backend", TORCH_BACKEND_PATH
    )
    backend = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    previous_common = sys.modules.get("common")
    sys.modules["common"] = common
    try:
        spec.loader.exec_module(backend)
    finally:
        if previous_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = previous_common
    return backend


torch_backend = _load_torch_backend()


class QwenStreamingEvaluatorTests(unittest.TestCase):
    def test_normalization_and_edit_counts_track_missing_phonemes(self):
        self.assertEqual(evaluator.normalize_text("你好，RTX 5080！"), "你好rtx5080")
        self.assertEqual(
            evaluator.edit_counts("爸爸把白布包摆好", "爸爸白布包摆好"),
            {
                "referenceChars": 8,
                "edits": 1,
                "deletions": 1,
                "substitutions": 0,
                "insertions": 0,
            },
        )

    def test_boundary_ratio_detects_a_provider_seam_jump(self):
        smooth_a = array.array("h", range(0, 1000, 10)).tobytes()
        smooth_b = array.array("h", range(1000, 2000, 10)).tobytes()
        jumped_b = array.array("h", range(10000, 11000, 10)).tobytes()
        self.assertLess(evaluator.pcm_boundary_ratio([smooth_a, smooth_b]), 2.0)
        self.assertGreater(evaluator.pcm_boundary_ratio([smooth_a, jumped_b]), 100.0)

    def test_winner_requires_realtime_and_a_significant_quality_gain(self):
        baseline = {
            "candidateId": "fast12-full",
            "realtimeQualified": True,
            "deletionRate": 0.10,
            "cer": 0.20,
            "boundaryRatioP95": 3.0,
            "ttfaP95Ms": 500.0,
        }
        too_small = {
            "candidateId": "fast16-full",
            "realtimeQualified": True,
            "deletionRate": 0.09,
            "cer": 0.19,
            "boundaryRatioP95": 2.0,
            "ttfaP95Ms": 650.0,
        }
        qualified_winner = {
            "candidateId": "fast24-full",
            "realtimeQualified": True,
            "deletionRate": 0.07,
            "cer": 0.19,
            "boundaryRatioP95": 1.5,
            "ttfaP95Ms": 850.0,
        }
        slow = {
            "candidateId": "fast36-full",
            "realtimeQualified": False,
            "deletionRate": 0.01,
            "cer": 0.02,
            "boundaryRatioP95": 1.0,
            "ttfaP95Ms": 1200.0,
        }
        self.assertEqual(
            evaluator.select_winner([baseline, too_small, qualified_winner, slow]),
            "fast24-full",
        )


class FakeDecoder:
    def __init__(self):
        self.resets = 0

    def reset_streaming_state(self):
        self.resets += 1


class StreamingModel:
    def __init__(self, sample_rate=24000):
        self.sample_rate = sample_rate
        self.speech_tokenizer = types.SimpleNamespace(decoder=FakeDecoder())
        self.calls = []

    def generate(self, text, stream=False, **kwargs):
        self.calls.append({"text": text, "stream": stream, **kwargs})
        return object()


class OldModel:
    sample_rate = 24000

    def __init__(self):
        self.speech_tokenizer = types.SimpleNamespace(decoder=FakeDecoder())

    def generate(self, text):
        return text


class PullGenerator:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.next_calls = 0
        self.exhausted = False
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        self.next_calls += 1
        if not self.chunks:
            self.exhausted = True
            raise StopIteration
        return self.chunks.pop(0)

    def close(self):
        self.closed = True


class QwenMlxStreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-test")
        common._mlx_pool = self.pool
        common._synth_tts_stream = None
        server._mlx_model_gate = threading.BoundedSemaphore(1)
        server._ref_wav = Path("/fake/ref.wav")
        server._ref_text = "reference"

    def tearDown(self):
        self.pool.shutdown(wait=True)

    def assert_gate_released(self):
        self.assertTrue(server._mlx_model_gate.acquire(blocking=False))
        server._mlx_model_gate.release()

    def test_prepare_gates_capability_for_new_old_and_non_24k_models(self):
        original_load = server._load_on_mlx
        server._load_on_mlx = lambda: None
        try:
            server._tts_model = StreamingModel()
            server._prepare_mlx()
            self.assertIs(common._synth_tts_stream, server._synth_mlx_stream)

            server._tts_model = OldModel()
            server._prepare_mlx()
            self.assertIsNone(common._synth_tts_stream)

            server._tts_model = StreamingModel(sample_rate=16000)
            server._prepare_mlx()
            self.assertIsNone(common._synth_tts_stream)
        finally:
            server._load_on_mlx = original_load

    def test_create_stream_uses_fixed_safe_generation_parameters(self):
        model = StreamingModel()
        server._tts_model = model

        server._create_mlx_stream("spoken sentence")

        self.assertEqual(len(model.calls), 1)
        self.assertEqual(
            model.calls[0],
            {
                "text": "spoken sentence",
                "stream": True,
                "ref_audio": str(server._ref_wav),
                "ref_text": "reference",
                "streaming_interval": 0.32,
                "max_tokens": 750,
            },
        )

    async def test_stream_is_pull_based_and_yields_before_provider_exhaustion(self):
        model = StreamingModel()
        provider = PullGenerator([(b"first",), (b"second",)])
        server._tts_model = model
        original_create = server._create_mlx_stream
        original_pull = server._pull_mlx_stream
        server._create_mlx_stream = lambda _spoken: provider

        def pull(generator):
            try:
                return next(generator)
            except StopIteration:
                return server._MLX_STREAM_DONE

        server._pull_mlx_stream = pull
        stream = server._synth_mlx_stream("hello")
        try:
            first = await anext(stream)
            self.assertEqual(first, {"type": "audio", "pcm": b"first"})
            self.assertEqual(provider.next_calls, 1)
            self.assertFalse(provider.exhausted)

            # The async generator is paused at yield, so it must not prefetch.
            await asyncio.sleep(0.02)
            self.assertEqual(provider.next_calls, 1)

            second = await anext(stream)
            self.assertEqual(second, {"type": "audio", "pcm": b"second"})
            self.assertEqual(provider.next_calls, 2)
            self.assertFalse(provider.exhausted)

            with self.assertRaises(StopAsyncIteration):
                await anext(stream)
            self.assertEqual(provider.next_calls, 3)
            self.assertTrue(provider.exhausted)
            self.assertTrue(provider.closed)
            self.assertEqual(model.speech_tokenizer.decoder.resets, 1)
            self.assert_gate_released()
        finally:
            server._create_mlx_stream = original_create
            server._pull_mlx_stream = original_pull
            await stream.aclose()

    async def test_cancel_waits_for_inflight_pull_then_closes_resets_and_releases_gate(self):
        model = StreamingModel()
        provider = PullGenerator([])
        pull_started = threading.Event()
        allow_pull_to_finish = threading.Event()
        server._tts_model = model
        original_create = server._create_mlx_stream
        original_pull = server._pull_mlx_stream
        server._create_mlx_stream = lambda _spoken: provider

        def blocking_pull(_generator):
            pull_started.set()
            allow_pull_to_finish.wait(timeout=2)
            return (b"late",)

        server._pull_mlx_stream = blocking_pull
        stream = server._synth_mlx_stream("hello")
        task = asyncio.create_task(anext(stream))
        try:
            started = await asyncio.get_running_loop().run_in_executor(
                None, pull_started.wait, 2
            )
            self.assertTrue(started)
            self.assertFalse(server._mlx_model_gate.acquire(blocking=False))

            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(provider.closed)
            allow_pull_to_finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

            self.assertTrue(provider.closed)
            self.assertEqual(model.speech_tokenizer.decoder.resets, 1)
            self.assert_gate_released()
        finally:
            allow_pull_to_finish.set()
            server._create_mlx_stream = original_create
            server._pull_mlx_stream = original_pull
            await stream.aclose()

    async def test_provider_error_still_closes_resets_and_releases_gate(self):
        model = StreamingModel()
        provider = PullGenerator([])
        server._tts_model = model
        original_create = server._create_mlx_stream
        original_pull = server._pull_mlx_stream
        server._create_mlx_stream = lambda _spoken: provider
        server._pull_mlx_stream = lambda _generator: (_ for _ in ()).throw(
            RuntimeError("provider failed")
        )
        stream = server._synth_mlx_stream("hello")
        try:
            with self.assertRaisesRegex(RuntimeError, "provider failed"):
                await anext(stream)
            self.assertTrue(provider.closed)
            self.assertEqual(model.speech_tokenizer.decoder.resets, 1)
            self.assert_gate_released()
        finally:
            server._create_mlx_stream = original_create
            server._pull_mlx_stream = original_pull
            await stream.aclose()

    def test_pull_fails_closed_on_wrong_sample_rate_without_numpy_dependency(self):
        result = types.SimpleNamespace(sample_rate=16000, audio=object())
        generator = iter((result,))
        fake_numpy = types.ModuleType("numpy")
        previous_numpy = sys.modules.get("numpy")
        sys.modules["numpy"] = fake_numpy
        try:
            with self.assertRaisesRegex(RuntimeError, "采样率"):
                server._pull_mlx_stream(generator)
        finally:
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy

    def test_pull_rejects_an_abnormally_large_declared_provider_result(self):
        result = types.SimpleNamespace(
            sample_rate=24000,
            samples=server.MLX_STREAMING_RESULT_MAX_SAMPLES + 1,
            audio=object(),
        )
        fake_numpy = types.ModuleType("numpy")
        previous_numpy = sys.modules.get("numpy")
        sys.modules["numpy"] = fake_numpy
        try:
            with self.assertRaisesRegex(RuntimeError, "块过长"):
                server._pull_mlx_stream(iter((result,)))
        finally:
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy

    def test_pull_converts_explicit_little_endian_and_rechunks_to_80ms(self):
        conversions = []

        class FakeArray:
            size = 4

            def reshape(self, _shape):
                return self

            def __mul__(self, _scale):
                return self

            def astype(self, dtype):
                conversions.append(dtype)
                return self

            def tobytes(self):
                return b"\x01\x00\x02\x00\x03\x00\x04\x00"

        fake_audio = FakeArray()
        fake_numpy = types.ModuleType("numpy")
        fake_numpy.float32 = object()
        fake_numpy.asarray = lambda _audio, dtype: fake_audio
        fake_numpy.isfinite = lambda _audio: types.SimpleNamespace(all=lambda: True)
        fake_numpy.clip = lambda audio, _low, _high: audio
        result = types.SimpleNamespace(sample_rate=24000, audio=object())
        previous_numpy = sys.modules.get("numpy")
        original_chunk_pcm = common.chunk_pcm
        sys.modules["numpy"] = fake_numpy
        common.chunk_pcm = lambda pcm, milliseconds: (
            pcm[:4],
            pcm[4:],
            milliseconds,
        )
        try:
            chunks = server._pull_mlx_stream(iter((result,)))
            self.assertEqual(chunks, (b"\x01\x00\x02\x00", b"\x03\x00\x04\x00", 80))
            self.assertEqual(conversions, ["<i2"])
        finally:
            common.chunk_pcm = original_chunk_pcm
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy

    def test_torch_backend_gates_streaming_adapter_after_prepare(self):
        captured = {}
        asr_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr-test")
        previous_mlx_pool = common._mlx_pool
        common._mlx_pool = asr_pool
        fake_qwen = types.ModuleType("tts_qwen3_torch")
        fake_qwen.configure_from_settings = lambda _pool: None
        fake_qwen.streaming_supported = lambda: True
        fake_qwen.synth_tts = lambda _text: b""
        fake_qwen.synth_tts_http = lambda _text: (b"", "audio/wav")
        fake_qwen.synth_tts_stream = lambda _text: None
        previous_qwen = sys.modules.get("tts_qwen3_torch")
        previous_run = common.run
        sys.modules["tts_qwen3_torch"] = fake_qwen
        common.run = lambda **kwargs: captured.update(kwargs)
        try:
            server._run_torch()
            self.assertIsNone(captured["synth_tts_stream"])
            common._synth_tts_stream = None
            captured["prepare"]()
            self.assertIs(common._synth_tts_stream, fake_qwen.synth_tts_stream)
            captured["tts_pool"].shutdown(wait=True)
        finally:
            asr_pool.shutdown(wait=True)
            common._mlx_pool = previous_mlx_pool
            common.run = previous_run
            if previous_qwen is None:
                sys.modules.pop("tts_qwen3_torch", None)
            else:
                sys.modules["tts_qwen3_torch"] = previous_qwen

    def test_windows_torch_default_prefers_low_latency_06b_model(self):
        self.assertEqual(
            torch_backend.WINDOWS_DEFAULT_MODEL,
            "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        )
        self.assertEqual(
            torch_backend.DEFAULT_MODEL,
            torch_backend.WINDOWS_DEFAULT_MODEL
            if sys.platform == "win32"
            else torch_backend.LINUX_DEFAULT_MODEL,
        )


class FasterQwenStreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen-fast-test")
        self.model = types.SimpleNamespace(generate_voice_clone_streaming=lambda **_kwargs: None)
        torch_backend._tts_executor = self.pool
        torch_backend._faster_streaming = True
        torch_backend._model = self.model
        torch_backend._ref_wav = Path("/fake/ref.wav")
        torch_backend._ref_text = "reference"
        torch_backend._language = "Chinese"
        torch_backend._model_gate = threading.BoundedSemaphore(1)

    def tearDown(self):
        self.pool.shutdown(wait=True)

    def assert_gate_released(self):
        self.assertTrue(torch_backend._model_gate.acquire(blocking=False))
        torch_backend._model_gate.release()

    def test_capability_requires_model_executor_and_public_iterator(self):
        self.assertTrue(torch_backend.streaming_supported())
        torch_backend._faster_streaming = False
        self.assertFalse(torch_backend.streaming_supported())
        torch_backend._faster_streaming = True
        torch_backend._tts_executor = None
        self.assertFalse(torch_backend.streaming_supported())
        torch_backend._tts_executor = self.pool
        torch_backend._model = object()
        self.assertFalse(torch_backend.streaming_supported())

    def test_create_stream_uses_fixed_public_generation_parameters(self):
        calls = []
        provider = PullGenerator([])
        self.model.generate_voice_clone_streaming = lambda **kwargs: (
            calls.append(kwargs) or provider
        )

        self.assertIs(torch_backend._create_faster_stream("你好"), provider)
        self.assertEqual(
            calls,
            [
                {
                    "text": "你好",
                    "language": "Chinese",
                    "ref_audio": str(torch_backend._ref_wav),
                    "ref_text": "reference",
                    "max_new_tokens": torch_backend.FASTER_MAX_NEW_TOKENS,
                    "non_streaming_mode": True,
                    "chunk_size": torch_backend.FASTER_STREAMING_CHUNK_STEPS,
                    "parity_mode": False,
                }
            ],
        )

    def test_reference_cache_warmup_uses_short_public_stream_and_closes_it(self):
        calls = []
        provider = PullGenerator(
            [
                ("warm-1", 24000, {"chunk_index": 0}),
                ("warm-2", 24000, {"chunk_index": 1}),
            ]
        )
        self.model.generate_voice_clone_streaming = lambda **kwargs: (
            calls.append(kwargs) or provider
        )
        original_convert = torch_backend._convert_faster_chunk
        torch_backend._convert_faster_chunk = lambda _audio, _rate: (b"warm",)
        try:
            torch_backend._warm_faster_reference_cache(self.model)
        finally:
            torch_backend._convert_faster_chunk = original_convert

        self.assertTrue(provider.closed)
        self.assertEqual(provider.next_calls, 3)
        self.assertEqual(
            calls,
            [
                {
                    "text": "你好",
                    "language": "Chinese",
                    "ref_audio": str(torch_backend._ref_wav),
                    "ref_text": "reference",
                    "max_new_tokens": torch_backend.FASTER_WARMUP_MAX_NEW_TOKENS,
                    "non_streaming_mode": True,
                    "chunk_size": torch_backend.FASTER_WARMUP_CHUNK_STEPS,
                    "parity_mode": False,
                }
            ],
        )

    async def test_stream_is_pull_based_without_prefetch(self):
        provider = PullGenerator(
            [
                ("provider-1", 24000, {"chunk_index": 0}),
                ("provider-2", 24000, {"chunk_index": 1}),
            ]
        )
        self.model.generate_voice_clone_streaming = lambda **_kwargs: provider
        original_convert = torch_backend._convert_faster_chunk
        torch_backend._convert_faster_chunk = lambda audio, _rate: (
            str(audio).encode("ascii"),
        )
        stream = torch_backend.synth_tts_stream("hello")
        try:
            self.assertEqual(
                await anext(stream), {"type": "audio", "pcm": b"provider-1"}
            )
            self.assertEqual(provider.next_calls, 1)
            await asyncio.sleep(0.02)
            self.assertEqual(provider.next_calls, 1)

            self.assertEqual(
                await anext(stream), {"type": "audio", "pcm": b"provider-2"}
            )
            self.assertEqual(provider.next_calls, 2)
            with self.assertRaises(StopAsyncIteration):
                await anext(stream)
            self.assertTrue(provider.closed)
            self.assert_gate_released()
        finally:
            torch_backend._convert_faster_chunk = original_convert
            await stream.aclose()

    async def test_stream_rejects_pathological_duration_for_text_length(self):
        provider = PullGenerator([])
        self.model.generate_voice_clone_streaming = lambda **_kwargs: provider
        original_pull = torch_backend._pull_faster_stream
        oversized = b"\x00\x00" * (
            torch_backend._stream_sample_limit("short text") + 1
        )
        torch_backend._pull_faster_stream = lambda _generator: (oversized,)
        stream = torch_backend.synth_tts_stream("short text")
        try:
            with self.assertRaisesRegex(RuntimeError, "输出时长异常"):
                await anext(stream)
            self.assertTrue(provider.closed)
            self.assert_gate_released()
        finally:
            torch_backend._pull_faster_stream = original_pull
            await stream.aclose()

    async def test_stream_trims_long_silence_and_keeps_two_chunk_preroll(self):
        silent = b"\x00\x00" * 1920
        quiet = (100).to_bytes(2, "little", signed=True) * 1920
        speech = (10000).to_bytes(2, "little", signed=True) * 1920
        provider = PullGenerator([])
        self.model.generate_voice_clone_streaming = lambda **_kwargs: provider
        original_pull = torch_backend._pull_faster_stream
        pulls = iter(
            [
                (silent,),
                (silent,),
                (quiet,),
                (quiet,),
                (speech,),
                torch_backend._FASTER_STREAM_DONE,
            ]
        )
        torch_backend._pull_faster_stream = lambda _generator: next(pulls)
        stream = torch_backend.synth_tts_stream("hello")
        try:
            emitted = []
            async for event in stream:
                emitted.append(event["pcm"])
            self.assertEqual(emitted, [quiet, quiet, speech])
            self.assert_gate_released()
        finally:
            torch_backend._pull_faster_stream = original_pull
            await stream.aclose()

    async def test_stream_rejects_provider_output_with_no_detectable_voice(self):
        silent = b"\x00\x00" * 1920
        provider = PullGenerator([])
        self.model.generate_voice_clone_streaming = lambda **_kwargs: provider
        original_pull = torch_backend._pull_faster_stream
        pulls = iter([(silent,), (silent,), torch_backend._FASTER_STREAM_DONE])
        torch_backend._pull_faster_stream = lambda _generator: next(pulls)
        stream = torch_backend.synth_tts_stream("hello")
        try:
            with self.assertRaisesRegex(RuntimeError, "未检测到有效语音"):
                await anext(stream)
            self.assert_gate_released()
        finally:
            torch_backend._pull_faster_stream = original_pull
            await stream.aclose()

    def test_stream_duration_guard_allows_normal_long_sentence_but_caps_gibberish(self):
        self.assertEqual(
            torch_backend._stream_sample_limit("短句"),
            common.OUTPUT_RATE * 20,
        )
        self.assertLess(
            torch_backend._stream_sample_limit("字" * 39),
            common.OUTPUT_RATE * 48,
        )

    async def test_cancel_waits_for_real_pull_before_close_and_gate_release(self):
        provider = PullGenerator([])
        pull_started = threading.Event()
        allow_pull_to_finish = threading.Event()
        self.model.generate_voice_clone_streaming = lambda **_kwargs: provider
        original_pull = torch_backend._pull_faster_stream

        def blocking_pull(_generator):
            pull_started.set()
            allow_pull_to_finish.wait(timeout=2)
            return (b"late",)

        torch_backend._pull_faster_stream = blocking_pull
        stream = torch_backend.synth_tts_stream("hello")
        task = asyncio.create_task(anext(stream))
        try:
            started = await asyncio.get_running_loop().run_in_executor(
                None, pull_started.wait, 2
            )
            self.assertTrue(started)
            self.assertFalse(torch_backend._model_gate.acquire(blocking=False))

            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(provider.closed)
            allow_pull_to_finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

            self.assertTrue(provider.closed)
            self.assert_gate_released()
        finally:
            allow_pull_to_finish.set()
            torch_backend._pull_faster_stream = original_pull
            await stream.aclose()

    def test_provider_chunk_is_rechunked_to_project_80ms_frames(self):
        class FakeValues:
            size = 12000

            def reshape(self, _shape):
                return self

        fake_numpy = types.ModuleType("numpy")
        fake_numpy.float32 = object()
        fake_numpy.asarray = lambda _audio, dtype: FakeValues()
        fake_numpy.isfinite = lambda _audio: types.SimpleNamespace(all=lambda: True)
        previous_numpy = sys.modules.get("numpy")
        original_convert = torch_backend._wav_to_pcm24k
        original_chunk = common.chunk_pcm
        sys.modules["numpy"] = fake_numpy
        torch_backend._wav_to_pcm24k = lambda _audio, _rate: b"abcdefgh"
        common.chunk_pcm = lambda pcm, milliseconds: (
            pcm[:4],
            pcm[4:],
            milliseconds,
        )
        try:
            self.assertEqual(
                torch_backend._convert_faster_chunk(object(), 24000),
                (b"abcd", b"efgh", 80),
            )
        finally:
            common.chunk_pcm = original_chunk
            torch_backend._wav_to_pcm24k = original_convert
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy

    def test_provider_chunk_rejects_non_finite_samples(self):
        class FakeValues:
            size = 10

            def reshape(self, _shape):
                return self

        fake_numpy = types.ModuleType("numpy")
        fake_numpy.float32 = object()
        fake_numpy.asarray = lambda _audio, dtype: FakeValues()
        fake_numpy.isfinite = lambda _audio: types.SimpleNamespace(all=lambda: False)
        previous_numpy = sys.modules.get("numpy")
        sys.modules["numpy"] = fake_numpy
        try:
            with self.assertRaisesRegex(RuntimeError, "无效采样"):
                torch_backend._convert_faster_chunk(object(), 24000)
        finally:
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy

    def test_provider_chunk_rejects_more_than_two_seconds(self):
        class FakeValues:
            size = torch_backend.FASTER_STREAMING_RESULT_MAX_SAMPLES + 1

            def reshape(self, _shape):
                return self

        fake_numpy = types.ModuleType("numpy")
        fake_numpy.float32 = object()
        fake_numpy.asarray = lambda _audio, dtype: FakeValues()
        fake_numpy.isfinite = lambda _audio: types.SimpleNamespace(all=lambda: True)
        previous_numpy = sys.modules.get("numpy")
        sys.modules["numpy"] = fake_numpy
        try:
            with self.assertRaisesRegex(RuntimeError, "输出块过长"):
                torch_backend._convert_faster_chunk(object(), 24000)
        finally:
            if previous_numpy is None:
                sys.modules.pop("numpy", None)
            else:
                sys.modules["numpy"] = previous_numpy


if __name__ == "__main__":
    unittest.main()
