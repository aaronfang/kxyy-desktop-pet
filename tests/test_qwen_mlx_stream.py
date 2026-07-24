import asyncio
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


def _load_server():
    fake_common = types.ModuleType("common")
    fake_common.OUTPUT_RATE = 24000
    fake_common._mlx_pool = None
    fake_common._synth_tts_stream = None
    fake_common.ensure_ref_wav = lambda: (Path("/fake/ref.wav"), "reference")
    fake_common.log = lambda _message: None
    fake_common.load_whisper_on_mlx_thread = lambda: None
    fake_common.text_for_speech = lambda text: text
    fake_common.clip_speech_text = lambda text: text.strip()
    fake_common.chunk_pcm = lambda pcm, _milliseconds: (pcm,)
    fake_common.run = lambda **_kwargs: None

    spec = importlib.util.spec_from_file_location("kxyy_qwen_mlx_server", SERVER_PATH)
    server = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    previous_common = sys.modules.get("common")
    sys.modules["common"] = fake_common
    try:
        spec.loader.exec_module(server)
    finally:
        if previous_common is None:
            sys.modules.pop("common", None)
        else:
            sys.modules["common"] = previous_common
    return server, fake_common


server, common = _load_server()


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
                "ref_audio": "/fake/ref.wav",
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

    def test_torch_backend_does_not_inject_streaming_adapter(self):
        captured = {}
        fake_qwen = types.ModuleType("tts_qwen3_torch")
        fake_qwen.configure_from_settings = lambda: None
        fake_qwen.synth_tts = lambda _text: b""
        fake_qwen.synth_tts_http = lambda _text: (b"", "audio/wav")
        previous_qwen = sys.modules.get("tts_qwen3_torch")
        previous_run = common.run
        sys.modules["tts_qwen3_torch"] = fake_qwen
        common.run = lambda **kwargs: captured.update(kwargs)
        try:
            server._run_torch()
            self.assertNotIn("synth_tts_stream", captured)
            captured["tts_pool"].shutdown(wait=True)
        finally:
            common.run = previous_run
            if previous_qwen is None:
                sys.modules.pop("tts_qwen3_torch", None)
            else:
                sys.modules["tts_qwen3_torch"] = previous_qwen


if __name__ == "__main__":
    unittest.main()
