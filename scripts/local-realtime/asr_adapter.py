"""Provider-neutral, in-memory adapters for local final ASR.

This module deliberately owns no service lifecycle.  Callers create one adapter at
startup and keep it for the process lifetime.  Runtime failures are represented by
fixed reason codes so paths, provider exceptions, and recognized text are never
accidentally exposed through error messages.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import os
from pathlib import Path
import platform
import re
import struct
import sys
import sysconfig
from typing import Callable, Mapping, Protocol


INPUT_RATE = 16000
WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"
WHISPER_PROMPT = "以下是一段中文对话，角色名叫元元。"
SENSEVOICE_RUNTIME_VERSION = "1.13.4"
SENSEVOICE_RUNTIME_MARKER = ".kxyy-sensevoice-ready"
SENSEVOICE_MODEL_DIRNAME = "sensevoice-small-int8-2024-07-17"
SENSEVOICE_MARKER_TEXT = (
    "sherpa-onnx=1.13.4\n"
    "model=sensevoice-small-int8-2024-07-17\n"
)

ASR_PROVIDERS = frozenset({"whisper", "sensevoice"})
ASR_LANGUAGES = frozenset({"unknown", "zh", "yue", "en", "ja", "ko", "nospeech"})
ASR_EMOTIONS = frozenset(
    {
        "unknown",
        "neutral",
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
    }
)
ASR_EVENTS = frozenset(
    {
        "unknown",
        "speech",
        "bgm",
        "applause",
        "laughter",
        "cry",
        "sneeze",
        "breath",
        "cough",
    }
)

_TAG_RE = re.compile(r"<\|([^|<>]{1,32})\|>")
_LANGUAGE_TAGS = {value: value for value in ASR_LANGUAGES if value != "unknown"}
_EMOTION_TAGS = {value.upper(): value for value in ASR_EMOTIONS if value != "unknown"}
_EVENT_TAGS = {
    "Speech": "speech",
    "BGM": "bgm",
    "Applause": "applause",
    "Laughter": "laughter",
    "Cry": "cry",
    "Sneeze": "sneeze",
    "Breath": "breath",
    "Cough": "cough",
}


@dataclass(frozen=True, slots=True)
class AsrResult:
    text: str
    no_speech_prob: float | None = None
    language: str = "unknown"
    emotion: str = "unknown"
    event: str = "unknown"

    def __post_init__(self) -> None:
        if self.language not in ASR_LANGUAGES:
            raise ValueError("invalid_asr_language")
        if self.emotion not in ASR_EMOTIONS:
            raise ValueError("invalid_asr_emotion")
        if self.event not in ASR_EVENTS:
            raise ValueError("invalid_asr_event")


class AsrAdapter(Protocol):
    def transcribe(self, pcm16: bytes) -> AsrResult: ...


class AsrAdapterError(RuntimeError):
    """An ASR failure whose string value is always a reviewed fixed reason."""

    _REASONS = frozenset(
        {
            "whisper_not_ready",
            "whisper_inference_failed",
            "sensevoice_runtime_missing",
            "sensevoice_runtime_invalid",
            "sensevoice_inference_failed",
        }
    )

    def __init__(self, reason: str):
        safe_reason = reason if reason in self._REASONS else "sensevoice_runtime_invalid"
        self.reason = safe_reason
        super().__init__(safe_reason)


class UnavailableAdapter:
    def transcribe(self, _pcm16: bytes) -> AsrResult:
        raise AsrAdapterError("whisper_not_ready")


def _normalize_machine(machine=None):
    value = str(machine or platform.machine()).strip().lower()
    if value in {"amd64", "x86_64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    return value


def sensevoice_platform_identity(
    *, system=None, machine=None, python_version=None, implementation=None, pointer_bits=None
) -> str:
    """Return the exact wheel identity used by the hash-locked installer."""

    system_name = str(system or platform.system()).strip().lower()
    arch = _normalize_machine(machine)
    version = python_version or sys.version_info[:2]
    implementation_name = str(
        implementation or getattr(sys.implementation, "name", "")
    ).lower()
    bits = int(pointer_bits or struct.calcsize("P") * 8)
    if implementation_name != "cpython" or bits != 64:
        raise AsrAdapterError("sensevoice_runtime_invalid")
    if not isinstance(version, (tuple, list)) or len(version) < 2 or version[0] != 3:
        raise AsrAdapterError("sensevoice_runtime_invalid")
    minor = int(version[1])
    if minor not in range(10, 15):
        raise AsrAdapterError("sensevoice_runtime_invalid")
    if system_name == "darwin" and arch in {"arm64", "x64"}:
        system_key = "macos"
    elif system_name == "windows" and arch == "x64":
        system_key = "windows"
    else:
        raise AsrAdapterError("sensevoice_runtime_invalid")
    return f"cp3{minor}-{system_key}-{arch}"


def sensevoice_runtime_fingerprint(*, identity=None, cache_tag=None, soabi=None) -> str:
    wheel_identity = identity or sensevoice_platform_identity()
    tag = str(cache_tag or getattr(sys.implementation, "cache_tag", "")).lower()
    abi = str(soabi if soabi is not None else sysconfig.get_config_var("SOABI") or "")
    digest = hashlib.sha256(abi.encode("utf-8")).hexdigest()[:12]
    fingerprint = f"{wheel_identity}-{tag}-{digest}"
    if not re.fullmatch(r"[a-z0-9_-]+", fingerprint):
        raise AsrAdapterError("sensevoice_runtime_invalid")
    return fingerprint


def sensevoice_runtime_target(runtime_root, *, fingerprint=None) -> Path:
    identity = fingerprint or sensevoice_runtime_fingerprint()
    if not re.fullmatch(r"[a-z0-9_-]+", identity):
        raise AsrAdapterError("sensevoice_runtime_invalid")
    return (
        Path(runtime_root)
        / identity
        / f"sherpa-onnx-{SENSEVOICE_RUNTIME_VERSION}"
    )


def _pcm16_to_float32(pcm16: bytes):
    import numpy as np

    usable = memoryview(pcm16)[: len(pcm16) - (len(pcm16) % 2)]
    return np.frombuffer(usable, dtype="<i2").astype(np.float32) / 32768.0


class WhisperAdapter:
    """Preserve the existing MLX/openai-whisper in-memory invocation contract."""

    def __init__(
        self,
        backend: str,
        *,
        openai_model=None,
        mlx_module=None,
        audio_converter: Callable[[bytes], object] = _pcm16_to_float32,
    ):
        if backend not in {"mlx", "openai"}:
            raise AsrAdapterError("whisper_not_ready")
        self._backend = backend
        self._openai_model = openai_model
        self._mlx_module = mlx_module
        self._audio_converter = audio_converter

    def transcribe(self, pcm16: bytes) -> AsrResult:
        try:
            audio = self._audio_converter(pcm16)
            if self._backend == "mlx":
                mlx_whisper = self._mlx_module or importlib.import_module("mlx_whisper")
                result = mlx_whisper.transcribe(
                    audio,
                    path_or_hf_repo=WHISPER_MODEL,
                    language="zh",
                    initial_prompt=WHISPER_PROMPT,
                    condition_on_previous_text=False,
                    verbose=False,
                )
                no_speech_prob = float(result.get("no_speech_prob") or 0.0)
                for segment in result.get("segments") or []:
                    no_speech_prob = max(
                        no_speech_prob,
                        float(segment.get("no_speech_prob") or 0.0),
                    )
            else:
                if self._openai_model is None:
                    raise AsrAdapterError("whisper_not_ready")
                result = self._openai_model.transcribe(
                    audio,
                    language="zh",
                    initial_prompt=WHISPER_PROMPT,
                    condition_on_previous_text=False,
                    verbose=False,
                )
                segments = result.get("segments") or []
                no_speech_prob = (
                    sum(float(segment.get("no_speech_prob") or 0.0) for segment in segments)
                    / len(segments)
                    if segments
                    else 0.0
                )
            return AsrResult(
                text=str(result.get("text") or "").strip(),
                no_speech_prob=no_speech_prob,
                language="zh",
            )
        except AsrAdapterError:
            raise
        except Exception:
            raise AsrAdapterError("whisper_inference_failed") from None


def sanitize_sensevoice_result(
    raw_text: object,
    *,
    raw_language: object = "",
    raw_emotion: object = "",
    raw_event: object = "",
) -> AsrResult:
    """Strip every provider tag and export only reviewed fixed label enums."""

    text = str(raw_text or "")
    language = "unknown"
    emotion = "unknown"
    event = "unknown"
    for match in _TAG_RE.finditer(text):
        tag = match.group(1)
        if language == "unknown" and tag in _LANGUAGE_TAGS:
            language = _LANGUAGE_TAGS[tag]
        elif emotion == "unknown" and tag in _EMOTION_TAGS:
            emotion = _EMOTION_TAGS[tag]
        elif event == "unknown" and tag in _EVENT_TAGS:
            event = _EVENT_TAGS[tag]
    language_tag = _TAG_RE.fullmatch(str(raw_language or "").strip())
    emotion_tag = _TAG_RE.fullmatch(str(raw_emotion or "").strip())
    event_tag = _TAG_RE.fullmatch(str(raw_event or "").strip())
    if language == "unknown" and language_tag:
        language = _LANGUAGE_TAGS.get(language_tag.group(1), "unknown")
    if emotion == "unknown" and emotion_tag:
        emotion = _EMOTION_TAGS.get(emotion_tag.group(1), "unknown")
    if event == "unknown" and event_tag:
        event = _EVENT_TAGS.get(event_tag.group(1), "unknown")
    # Unknown tags are removed too: provider-controlled labels must never cross the
    # adapter as either metadata or apparent user text.
    clean_text = _TAG_RE.sub("", text).strip()
    return AsrResult(
        text=clean_text,
        language=language,
        emotion=emotion,
        event=event,
    )


class SenseVoiceAdapter:
    def __init__(self, recognizer):
        self._recognizer = recognizer

    @classmethod
    def from_runtime_root(
        cls,
        runtime_root: str | os.PathLike[str] | None,
        *,
        fingerprint: str | None = None,
        module_loader: Callable[[str], object] = importlib.import_module,
    ) -> "SenseVoiceAdapter":
        if not runtime_root:
            raise AsrAdapterError("sensevoice_runtime_missing")
        try:
            target = sensevoice_runtime_target(runtime_root, fingerprint=fingerprint)
        except AsrAdapterError:
            raise
        marker = target / SENSEVOICE_RUNTIME_MARKER
        model_dir = target / SENSEVOICE_MODEL_DIRNAME
        model = model_dir / "model.int8.onnx"
        tokens = model_dir / "tokens.txt"
        if (
            not target.is_dir()
            or target.is_symlink()
            or not marker.is_file()
            or marker.is_symlink()
            or not model.is_file()
            or model.is_symlink()
            or not tokens.is_file()
            or tokens.is_symlink()
        ):
            raise AsrAdapterError("sensevoice_runtime_missing")
        try:
            if marker.read_text(encoding="utf-8") != SENSEVOICE_MARKER_TEXT:
                raise AsrAdapterError("sensevoice_runtime_invalid")
            site_path = str(target)
            if site_path not in sys.path:
                sys.path.insert(0, site_path)
            sherpa_onnx = module_loader("sherpa_onnx")
            recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(model),
                tokens=str(tokens),
                num_threads=2,
                language="auto",
                use_itn=True,
                debug=False,
                provider="cpu",
            )
        except AsrAdapterError:
            raise
        except Exception:
            raise AsrAdapterError("sensevoice_runtime_invalid") from None
        return cls(recognizer)

    def transcribe(self, pcm16: bytes) -> AsrResult:
        try:
            audio = _pcm16_to_float32(pcm16)
            stream = self._recognizer.create_stream()
            stream.accept_waveform(INPUT_RATE, audio)
            self._recognizer.decode_stream(stream)
            result = stream.result
            return sanitize_sensevoice_result(
                result.text,
                raw_language=getattr(result, "lang", ""),
                raw_emotion=getattr(result, "emotion", ""),
                raw_event=getattr(result, "event", ""),
            )
        except Exception:
            raise AsrAdapterError("sensevoice_inference_failed") from None


@dataclass(frozen=True, slots=True)
class AsrSelection:
    adapter: AsrAdapter
    requested_provider: str
    active_provider: str
    fallback_reason: str | None = None


def select_asr_adapter(
    whisper: AsrAdapter,
    *,
    environ: Mapping[str, str] | None = None,
    module_loader: Callable[[str], object] = importlib.import_module,
) -> AsrSelection:
    """Select once at startup; unavailable SenseVoice has a fixed Whisper fallback."""

    env = os.environ if environ is None else environ
    requested = str(env.get("KXYY_ASR_PROVIDER") or "whisper").strip().lower()
    if requested not in ASR_PROVIDERS:
        return AsrSelection(whisper, requested, "whisper", "provider_invalid")
    if requested == "whisper":
        return AsrSelection(whisper, requested, "whisper")
    try:
        sensevoice = SenseVoiceAdapter.from_runtime_root(
            env.get("KXYY_ASR_RUNTIME_ROOT"),
            module_loader=module_loader,
        )
    except AsrAdapterError as error:
        return AsrSelection(whisper, requested, "whisper", error.reason)
    return AsrSelection(sensevoice, requested, "sensevoice")
