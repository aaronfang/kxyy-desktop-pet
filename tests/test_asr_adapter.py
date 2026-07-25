import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "local-realtime"
    / "asr_adapter.py"
)
SPEC = importlib.util.spec_from_file_location("local_realtime_asr_adapter", MODULE_PATH)
asr = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = asr
SPEC.loader.exec_module(asr)


class WhisperAdapterTests(unittest.TestCase):
    def test_mlx_preserves_reviewed_parameters_and_max_no_speech(self):
        captured = {}

        def transcribe(audio, **kwargs):
            captured.update(audio=audio, kwargs=kwargs)
            return {
                "text": " 测试 ",
                "no_speech_prob": 0.1,
                "segments": [{"no_speech_prob": 0.4}],
            }

        adapter = asr.WhisperAdapter(
            "mlx",
            mlx_module=types.SimpleNamespace(transcribe=transcribe),
            audio_converter=lambda pcm: ("audio", pcm),
        )
        result = adapter.transcribe(b"pcm")

        self.assertEqual(result.text, "测试")
        self.assertEqual(result.no_speech_prob, 0.4)
        self.assertEqual(result.language, "zh")
        self.assertEqual(captured["audio"], ("audio", b"pcm"))
        self.assertEqual(captured["kwargs"]["path_or_hf_repo"], asr.WHISPER_MODEL)
        self.assertEqual(captured["kwargs"]["initial_prompt"], asr.WHISPER_PROMPT)
        self.assertFalse(captured["kwargs"]["condition_on_previous_text"])
        self.assertFalse(captured["kwargs"]["verbose"])

    def test_openai_preserves_parameters_and_average_no_speech(self):
        captured = {}

        class Model:
            def transcribe(self, audio, **kwargs):
                captured.update(audio=audio, kwargs=kwargs)
                return {
                    "text": "本地识别",
                    "segments": [
                        {"no_speech_prob": 0.2},
                        {"no_speech_prob": 0.4},
                    ],
                }

        adapter = asr.WhisperAdapter(
            "openai",
            openai_model=Model(),
            audio_converter=lambda pcm: pcm,
        )
        result = adapter.transcribe(b"pcm")

        self.assertAlmostEqual(result.no_speech_prob, 0.3)
        self.assertEqual(captured["kwargs"]["language"], "zh")
        self.assertEqual(captured["kwargs"]["initial_prompt"], asr.WHISPER_PROMPT)
        self.assertFalse(captured["kwargs"]["condition_on_previous_text"])

    def test_provider_exception_is_replaced_by_fixed_reason(self):
        module = types.SimpleNamespace(
            transcribe=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("secret /Users/private transcript")
            )
        )
        adapter = asr.WhisperAdapter(
            "mlx", mlx_module=module, audio_converter=lambda pcm: pcm
        )

        with self.assertRaisesRegex(asr.AsrAdapterError, "^whisper_inference_failed$"):
            adapter.transcribe(b"pcm")


class SenseVoiceAdapterTests(unittest.TestCase):
    FINGERPRINT = "cp313-macos-arm64-cpython-313-testabi"

    def _runtime(self, directory: str) -> Path:
        root = Path(directory)
        target = asr.sensevoice_runtime_target(
            root, fingerprint=self.FINGERPRINT
        )
        target.mkdir(parents=True)
        model = target / asr.SENSEVOICE_MODEL_DIRNAME
        model.mkdir(parents=True)
        (model / "model.int8.onnx").touch()
        (model / "tokens.txt").touch()
        (target / asr.SENSEVOICE_RUNTIME_MARKER).write_text(
            asr.SENSEVOICE_MARKER_TEXT, encoding="utf-8"
        )
        return root

    def test_runtime_fingerprint_contract_matches_installer_layout(self):
        fingerprint = asr.sensevoice_runtime_fingerprint(
            identity="cp313-macos-arm64",
            cache_tag="cpython-313",
            soabi="cpython-313-darwin",
        )
        expected_digest = __import__("hashlib").sha256(
            b"cpython-313-darwin"
        ).hexdigest()[:12]
        self.assertEqual(
            fingerprint,
            f"cp313-macos-arm64-cpython-313-{expected_digest}",
        )
        self.assertEqual(
            asr.sensevoice_runtime_target("/runtime", fingerprint=fingerprint),
            Path("/runtime")
            / fingerprint
            / "sherpa-onnx-1.13.4",
        )

    def test_strict_tag_allowlist_and_unknown_tag_removal(self):
        result = asr.sanitize_sensevoice_result(
            "<|zh|><|HAPPY|><|Laughter|><|withitn|><|provider-secret|> 你好"
        )

        self.assertEqual(result.text, "你好")
        self.assertEqual(result.language, "zh")
        self.assertEqual(result.emotion, "happy")
        self.assertEqual(result.event, "laughter")
        self.assertIsNone(result.no_speech_prob)

        structured = asr.sanitize_sensevoice_result(
            "结构化结果",
            raw_language="<|zh|>",
            raw_emotion="<|SAD|>",
            raw_event="<|Cough|>",
        )
        self.assertEqual(
            (structured.language, structured.emotion, structured.event),
            ("zh", "sad", "cough"),
        )

    def test_all_reviewed_official_emotion_and_event_labels_are_fixed(self):
        for tag, expected in {
            "NEUTRAL": "neutral",
            "HAPPY": "happy",
            "SAD": "sad",
            "ANGRY": "angry",
            "FEARFUL": "fearful",
            "DISGUSTED": "disgusted",
            "SURPRISED": "surprised",
        }.items():
            self.assertEqual(
                asr.sanitize_sensevoice_result(f"<|{tag}|>测试").emotion,
                expected,
            )
        for tag, expected in {
            "Speech": "speech",
            "BGM": "bgm",
            "Applause": "applause",
            "Laughter": "laughter",
            "Cry": "cry",
            "Sneeze": "sneeze",
            "Breath": "breath",
            "Cough": "cough",
        }.items():
            self.assertEqual(
                asr.sanitize_sensevoice_result(f"<|{tag}|>测试").event,
                expected,
            )

    def test_runtime_contract_and_in_memory_pcm(self):
        captured = {}

        class Stream:
            result = types.SimpleNamespace(
                text="你好",
                lang="<|yue|>",
                emotion="<|NEUTRAL|>",
                event="<|Speech|>",
            )

            def accept_waveform(self, sample_rate, audio):
                captured["waveform"] = (sample_rate, list(audio))

        class Recognizer:
            @classmethod
            def from_sense_voice(cls, **kwargs):
                captured["config"] = kwargs
                return cls()

            def create_stream(self):
                return Stream()

            def decode_stream(self, stream):
                captured["decoded"] = stream

        module = types.SimpleNamespace(OfflineRecognizer=Recognizer)
        with tempfile.TemporaryDirectory() as directory:
            root = self._runtime(directory)
            adapter = asr.SenseVoiceAdapter.from_runtime_root(
                root,
                fingerprint=self.FINGERPRINT,
                module_loader=lambda name: module,
            )
            result = adapter.transcribe(struct.pack("<hh", -32768, 32767))

        self.assertEqual(captured["config"]["num_threads"], 2)
        self.assertEqual(captured["config"]["language"], "auto")
        self.assertTrue(captured["config"]["use_itn"])
        self.assertFalse(captured["config"]["debug"])
        self.assertEqual(captured["config"]["provider"], "cpu")
        self.assertEqual(
            captured["config"]["model"],
            str(
                asr.sensevoice_runtime_target(
                    root, fingerprint=self.FINGERPRINT
                )
                / asr.SENSEVOICE_MODEL_DIRNAME
                / "model.int8.onnx"
            ),
        )
        self.assertEqual(captured["waveform"][0], 16000)
        self.assertAlmostEqual(captured["waveform"][1][0], -1.0)
        self.assertAlmostEqual(captured["waveform"][1][1], 32767 / 32768)
        self.assertEqual(result.language, "yue")
        self.assertEqual(result.text, "你好")

    def test_missing_runtime_falls_back_to_whisper_with_fixed_reason(self):
        whisper = object()
        selection = asr.select_asr_adapter(
            whisper,
            environ={
                "KXYY_ASR_PROVIDER": "sensevoice",
                "KXYY_ASR_RUNTIME_ROOT": "/private/secret/missing",
            },
        )

        self.assertIs(selection.adapter, whisper)
        self.assertEqual(selection.requested_provider, "sensevoice")
        self.assertEqual(selection.active_provider, "whisper")
        self.assertEqual(selection.fallback_reason, "sensevoice_runtime_missing")
        self.assertNotIn("private", repr(selection))

    def test_invalid_runtime_exception_does_not_expose_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self._runtime(directory)
            with mock.patch.object(
                asr,
                "sensevoice_runtime_fingerprint",
                return_value=self.FINGERPRINT,
            ):
                selection = asr.select_asr_adapter(
                    object(),
                    environ={
                        "KXYY_ASR_PROVIDER": "sensevoice",
                        "KXYY_ASR_RUNTIME_ROOT": str(root),
                    },
                    module_loader=lambda _name: (_ for _ in ()).throw(
                        RuntimeError("secret /Users/private")
                    ),
                )

        self.assertEqual(selection.fallback_reason, "sensevoice_runtime_invalid")
        self.assertNotIn("secret", repr(selection))
        self.assertNotIn("private", repr(selection))

    def test_marker_mismatch_is_rejected_without_glob_or_current_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self._runtime(directory)
            target = asr.sensevoice_runtime_target(
                root, fingerprint=self.FINGERPRINT
            )
            (target / asr.SENSEVOICE_RUNTIME_MARKER).write_text(
                "sherpa-onnx=wrong\n", encoding="utf-8"
            )
            current_model = root / "current" / "model"
            current_model.mkdir(parents=True)
            (current_model / "model.int8.onnx").touch()
            (current_model / "tokens.txt").touch()

            with self.assertRaisesRegex(
                asr.AsrAdapterError, "^sensevoice_runtime_invalid$"
            ):
                asr.SenseVoiceAdapter.from_runtime_root(
                    root,
                    fingerprint=self.FINGERPRINT,
                    module_loader=lambda _name: object(),
                )

    def test_invalid_direct_result_enum_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "^invalid_asr_emotion$"):
            asr.AsrResult(text="x", emotion="provider-controlled")


if __name__ == "__main__":
    unittest.main()
