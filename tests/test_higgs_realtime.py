import importlib.util
import os
import sys
import threading
import types
import unittest
from pathlib import Path


SERVER_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "local-realtime"
    / "server_higgs.py"
)


def _load_server():
    fake_common = types.ModuleType("common")
    fake_common.REPO = Path("/fake/repo")
    fake_common.OUTPUT_RATE = 24000
    fake_common._mlx_pool = None
    fake_common.load_settings = lambda: {}
    fake_common.text_for_speech = lambda text: text
    fake_common.clip_speech_text = lambda text: text.strip()
    fake_common.chunk_pcm = lambda pcm, _duration: (pcm,)
    fake_common.detect_emotion = lambda text: "excited" if "哈哈" in text else "neutral"
    fake_common.load_whisper_on_mlx_thread = lambda: None
    fake_common.log = lambda _message: None
    fake_common.pcm16_to_browser_wav = lambda pcm, _rate: pcm
    fake_common.run = lambda **_kwargs: None
    fake_silero = types.ModuleType("silero_shadow")
    fake_silero.capability_from_environment = lambda: None

    spec = importlib.util.spec_from_file_location("kxyy_higgs_realtime", SERVER_PATH)
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
    return server


server = _load_server()


class HiggsEmotionPolicyTests(unittest.TestCase):
    def test_surprise_never_adds_a_control_token(self):
        text = "真的假的？这个结果完全超出我的预料！"
        self.assertEqual(server._higgs_controls(text, text), "")

    def test_amusement_uses_emotion_without_expressive_high(self):
        text = "哈哈，你刚才那句话也太好笑了。"
        self.assertEqual(
            server._higgs_controls(text, text),
            "<|emotion:amusement|>",
        )

    def test_contemplation_keeps_the_accepted_slow_mapping(self):
        text = "让我想一想，也许可以换一个角度。"
        self.assertEqual(
            server._higgs_controls(text, text),
            "<|emotion:contemplation|><|prosody:speed_slow|>",
        )

    def test_policy_never_emits_rejected_prosody(self):
        probes = [
            "哈哈，太好笑了！",
            "真的假的？",
            "让我想一想。",
            "普通的一句话。",
        ]
        controls = "".join(server._higgs_controls(text, text) for text in probes)
        self.assertNotIn("pitch_high", controls)
        self.assertNotIn("expressive_high", controls)
        self.assertNotIn("emotion:surprise", controls)


class HiggsSynthesisTests(unittest.TestCase):
    def tearDown(self):
        server._model = None
        server._ref_wav = None
        server._ref_text = ""
        server._ref_codes = None
        server._gate = threading.BoundedSemaphore(1)

    def test_synthesis_uses_cached_reference_and_stable_temperature(self):
        import numpy as np

        calls = []

        class FakeModel:
            def generate(self, **kwargs):
                calls.append(kwargs)
                return iter(
                    [types.SimpleNamespace(audio=np.array([0.0, 0.5], dtype=np.float32), sample_rate=24000)]
                )

        server._model = FakeModel()
        server._ref_wav = Path("/fake/ref.wav")
        server._ref_text = "reference"
        server._ref_codes = object()
        pcm = server._synth("哈哈，太好笑了！")

        self.assertEqual(len(pcm), 4)
        self.assertEqual(calls[0]["temperature"], 0.3)
        self.assertIs(calls[0]["ref_audio_codes"], server._ref_codes)
        self.assertTrue(calls[0]["text"].startswith("<|emotion:amusement|>"))
        self.assertNotIn("expressive_high", calls[0]["text"])

    def test_streaming_capability_requires_v3_internal_api(self):
        class FakeModel:
            sample_rate = 24000
            backbone = object()

            _normalize_references = lambda self: None
            _build_prompt_embeddings = lambda self: None
            _audio_logits = lambda self: None
            _embed_audio_codes = lambda self: None
            _decode_audio = lambda self: None

        previous = os.environ.pop("KXYY_HIGGS_STREAMING", None)
        try:
            self.assertTrue(server._streaming_supported(FakeModel()))
        finally:
            if previous is None:
                os.environ.pop("KXYY_HIGGS_STREAMING", None)
            else:
                os.environ["KXYY_HIGGS_STREAMING"] = previous
        self.assertFalse(server._streaming_supported(types.SimpleNamespace(sample_rate=24000)))

    def test_realtime_text_is_split_without_losing_the_tail(self):
        text = "哎，这不搁这儿躺着嘛，睡不着。你呢，这么晚了还精神着呢？"
        parts = server._split_realtime_text(text)

        self.assertEqual("".join(parts), text)
        self.assertGreaterEqual(len(parts), 2)
        self.assertTrue(all(1 <= len(part) <= server.REALTIME_PIECE_MAX_CHARS for part in parts))

    def test_short_realtime_text_has_a_bounded_generation_budget(self):
        self.assertLessEqual(server._max_realtime_tokens("哦～"), 64)
        self.assertLess(server._max_realtime_tokens("哦～"), server.MAX_NEW_TOKENS)
        self.assertLessEqual(
            server._max_realtime_tokens("你呢，这么晚了还精神着呢？"),
            server.REALTIME_MAX_NEW_TOKENS,
        )
        self.assertEqual(server.REALTIME_PREFETCH_CHUNKS * 80, 2560)
        self.assertEqual(server.REALTIME_CONTINUATION_PREFETCH_CHUNKS * 80, 1280)

    def test_streaming_can_be_disabled_for_ab_fallback(self):
        previous = os.environ.get("KXYY_HIGGS_STREAMING")
        os.environ["KXYY_HIGGS_STREAMING"] = "0"
        try:
            self.assertFalse(server._streaming_supported(object()))
        finally:
            if previous is None:
                os.environ.pop("KXYY_HIGGS_STREAMING", None)
            else:
                os.environ["KXYY_HIGGS_STREAMING"] = previous

    def test_prefix_emitter_preserves_length_and_smooths_boundary(self):
        import numpy as np

        emitter = server._PrefixPcmEmitter(sample_rate=1000, overlap_ms=16)
        first_prefix = np.linspace(-0.5, 0.5, 20, dtype=np.float32)
        # The later decode changes the unstable right edge of the first prefix.
        final_prefix = np.concatenate(
            (first_prefix[:16], np.linspace(0.3, 0.6, 4), np.full(10, 0.6)),
        ).astype(np.float32)

        first = emitter.emit(first_prefix, final=False)
        final = emitter.emit(final_prefix, final=True)
        combined = np.concatenate((first, final))

        self.assertEqual(combined.size, final_prefix.size)
        self.assertTrue(np.isfinite(combined).all())
        self.assertLess(float(np.max(np.abs(np.diff(combined)))), 0.7)

    def test_prefix_emitter_waits_until_overlap_is_available(self):
        import numpy as np

        emitter = server._PrefixPcmEmitter(sample_rate=1000, overlap_ms=16)
        self.assertEqual(
            emitter.emit(np.array([0.0, 0.1]), final=False).size,
            0,
        )
        final = emitter.emit(np.linspace(0.0, 0.5, 8), final=True)
        self.assertEqual(final.size, 8)

    def test_decode_window_stays_bounded_for_long_utterances(self):
        starts = [
            server._decode_window_start(total, 64)
            for total in (16, 64, 80, 256, 1024)
        ]
        self.assertEqual(starts, [0, 0, 16, 192, 960])
        self.assertTrue(
            all(total - start <= 64 for total, start in zip((16, 64, 80, 256, 1024), starts))
        )

    def test_prefix_emitter_accepts_a_shifted_decode_window(self):
        import numpy as np

        emitter = server._PrefixPcmEmitter(sample_rate=1000, overlap_ms=4)
        first = emitter.emit(np.linspace(0.0, 0.4, 20), final=False)
        shifted = emitter.emit(
            np.linspace(0.2, 0.8, 24),
            window_start_samples=8,
            final=True,
        )
        combined = np.concatenate((first, shifted))

        self.assertEqual(combined.size, 32)
        self.assertTrue(np.isfinite(combined).all())


class HiggsStreamingAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        server._model = None
        server._ref_codes = None
        server._gate = threading.BoundedSemaphore(1)

    async def test_adapter_chunks_pcm_and_releases_gate(self):
        import numpy as np

        original = server._iter_higgs_prefixes
        server._model = object()
        server._ref_codes = object()
        server._iter_higgs_prefixes = lambda _target, **_kwargs: iter(
            [np.array([0.0, 0.5], dtype=np.float32)]
        )
        try:
            chunks = [item async for item in server._synth_higgs_stream("测试")]
        finally:
            server._iter_higgs_prefixes = original

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["type"], "audio")
        self.assertEqual(len(chunks[0]["pcm"]), 4)
        self.assertTrue(server._gate.acquire(blocking=False))
        server._gate.release()

    async def test_adapter_prefetches_a_bounded_reservoir_before_first_audio(self):
        import numpy as np

        original = server._iter_higgs_prefixes
        pulls = 0

        def prefixes(_target, **_kwargs):
            nonlocal pulls
            for _ in range(40):
                pulls += 1
                yield np.array([0.0, 0.25], dtype=np.float32)

        server._model = object()
        server._ref_codes = object()
        server._iter_higgs_prefixes = prefixes
        stream = server._synth_higgs_stream("稍微长一点的测试句子")
        try:
            first = await anext(stream)
            self.assertEqual(first["type"], "audio")
            self.assertEqual(pulls, server.REALTIME_PREFETCH_CHUNKS)
            remaining = [item async for item in stream]
        finally:
            await stream.aclose()
            server._iter_higgs_prefixes = original

        self.assertEqual(len(remaining), 39)
        self.assertTrue(server._gate.acquire(blocking=False))
        server._gate.release()


if __name__ == "__main__":
    unittest.main()
