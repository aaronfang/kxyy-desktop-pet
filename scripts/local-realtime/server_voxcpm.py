#!/usr/bin/env python3
"""VoxCPM2 local zero-shot clone backend (WS :19878, HTTP :19978).

The model is intentionally kept outside the installer until its A/B result is
accepted. Set ``KXYY_VOXCPM_MODEL`` or use the development checkout at
``scripts/voxcpm-ab/work/models/VoxCPM2``.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import threading

import common
import silero_shadow

PORT = 19878
MODEL_DIR = common.REPO / "scripts" / "voxcpm-ab" / "work" / "models" / "VoxCPM2"
OUTPUT_RATE = 48000
FIXED_SEED = 424242
WINDOWS_STREAMING_INFERENCE_STEPS = 6
DEFAULT_INFERENCE_STEPS = 10
_model = None
_ref_wav = None
_ref_text = ""
_prompt_cache = None
_prompt_cache_key = None
_gate = threading.BoundedSemaphore(1)
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voxcpm")
_DONE = object()
PROVIDER_CLEANUP_WAIT_SECONDS = 5.0


def _model_path() -> str:
    raw = __import__("os").environ.get("KXYY_VOXCPM_MODEL", "").strip()
    path = Path(raw).expanduser() if raw else MODEL_DIR
    if not path.is_absolute():
        path = (common.REPO / path).resolve()
    if not path.is_dir():
        raise SystemExit(f"未找到 VoxCPM2 模型：{path}。请先运行 scripts/voxcpm-ab/setup.ps1")
    return str(path)


def _reference() -> tuple[Path, str]:
    # Keep the same explicit reference/preset precedence as Qwen3.
    try:
        from tts_qwen3_torch import _validated_voice_preset
        selected = _validated_voice_preset(common.load_settings())
        if selected is not None:
            return selected
    except Exception:
        pass
    return common.ensure_ref_wav()


def _spoken(text: str) -> str:
    return common.clip_speech_text(common.text_for_speech(text) or text)


def _to_pcm24(audio):
    import numpy as np
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if values.size == 0 or not np.isfinite(values).all():
        raise RuntimeError("VoxCPM2 输出为空或包含无效采样")
    # VoxCPM2 is natively 48 kHz; project playback and envelope are 24 kHz.
    values = values[: values.size - (values.size % 2) : 2]
    return (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _kwargs(text: str) -> dict:
    global _ref_wav, _ref_text
    _ref_wav, _ref_text = _reference()
    return dict(text=_spoken(text), prompt_wav_path=str(_ref_wav),
                prompt_text=_ref_text, reference_wav_path=str(_ref_wav),
                cfg_value=2.0,
                inference_timesteps=(
                    WINDOWS_STREAMING_INFERENCE_STEPS
                    if sys.platform == "win32"
                    else DEFAULT_INFERENCE_STEPS
                ),
                seed=FIXED_SEED)


def _prompt_cache_identity() -> tuple[str, int, int, str]:
    if _ref_wav is None:
        raise RuntimeError("VoxCPM2 reference is not ready")
    stat = _ref_wav.stat()
    return (str(_ref_wav.absolute()), stat.st_mtime_ns, stat.st_size, _ref_text)


def _ensure_prompt_cache():
    """Encode the current reference once; rebuild atomically after a hot switch."""
    global _prompt_cache, _prompt_cache_key
    key = _prompt_cache_identity()
    if _prompt_cache is not None and key == _prompt_cache_key:
        return _prompt_cache
    tts_model = getattr(_model, "tts_model", None)
    build = getattr(tts_model, "build_prompt_cache", None)
    if not callable(build):
        raise RuntimeError("VoxCPM2 prompt cache API is unavailable")
    built = build(
        prompt_text=_ref_text,
        prompt_wav_path=str(_ref_wav),
        reference_wav_path=str(_ref_wav),
    )
    _prompt_cache = built
    _prompt_cache_key = key
    return built


def _cached_generation_kwargs(text: str) -> dict:
    steps = WINDOWS_STREAMING_INFERENCE_STEPS if sys.platform == "win32" else DEFAULT_INFERENCE_STEPS
    return {
        "target_text": _spoken(text),
        "prompt_cache": _ensure_prompt_cache(),
        "cfg_value": 2.0,
        "inference_timesteps": steps,
        "max_len": 4096,
        "retry_badcase": True,
        "retry_badcase_max_times": 3,
        "retry_badcase_ratio_threshold": 6.0,
        "seed": FIXED_SEED,
    }


def _audio_to_numpy(audio):
    value = audio
    if hasattr(value, "squeeze"):
        value = value.squeeze(0)
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return value


def _provider_stream(text: str):
    # Refresh the hot-selectable reference before resolving its cache identity.
    fallback_kwargs = _kwargs(text)
    tts_model = getattr(_model, "tts_model", None)
    generate = getattr(tts_model, "generate_with_prompt_cache_streaming", None)
    if callable(generate):
        emitted = False
        try:
            for result in generate(**_cached_generation_kwargs(text)):
                audio = result[0] if isinstance(result, tuple) else result
                converted = _audio_to_numpy(audio)
                emitted = True
                yield converted
            return
        except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
            if emitted:
                raise
            common.log("VoxCPM2 prompt cache unavailable; using direct reference encoding")
    yield from _model.generate_streaming(**fallback_kwargs)


def _provider_generate(text: str):
    fallback_kwargs = _kwargs(text)
    tts_model = getattr(_model, "tts_model", None)
    generate = getattr(tts_model, "generate_with_prompt_cache", None)
    if callable(generate):
        try:
            result = generate(**_cached_generation_kwargs(text))
            audio = result[0] if isinstance(result, tuple) else result
            return _audio_to_numpy(audio)
        except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
            common.log("VoxCPM2 prompt cache unavailable; using direct reference encoding")
    return _model.generate(**fallback_kwargs)


def _synth(text: str) -> bytes:
    if not _gate.acquire(blocking=False):
        raise RuntimeError("VoxCPM2 正忙，请稍后再试")
    try:
        return _to_pcm24(_provider_generate(text))
    finally:
        _gate.release()


def _pull(generator):
    try:
        return next(generator)
    except StopIteration:
        return _DONE


def _close_stream(generator) -> None:
    generator.close()


async def _synth_stream(text: str):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + PROVIDER_CLEANUP_WAIT_SECONDS
    while not _gate.acquire(blocking=False):
        if loop.time() >= deadline:
            raise common.VoiceServiceRestartRequired(
                "VoxCPM2 上一轮清理超时，正在恢复语音服务"
            )
        await asyncio.sleep(0.02)
    generator = None
    try:
        generator = _provider_stream(text)
        while True:
            chunk = await loop.run_in_executor(_pool, _pull, generator)
            if chunk is _DONE:
                break
            pcm = _to_pcm24(chunk)
            for part in common.chunk_pcm(pcm, 80):
                yield {"type": "audio", "pcm": part}
    finally:
        if generator is None:
            _gate.release()
        else:
            # A cancelled run_in_executor await does not stop its in-flight next().
            # Close on the same single worker and keep the model gate held until the
            # provider iterator is no longer executing.
            try:
                cleanup = loop.run_in_executor(_pool, _close_stream, generator)
            except Exception:
                _gate.release()
                raise
            gate_released = False

            def release_gate(future) -> None:
                nonlocal gate_released
                if gate_released:
                    return
                gate_released = True
                try:
                    if not future.cancelled():
                        future.exception()
                finally:
                    _gate.release()

            cleanup.add_done_callback(release_gate)
            # Do not await the cleanup from generator cancellation.  The provider
            # iterator may still be inside next() on the single worker; the queued
            # close will run there and the callback keeps the gate held until it is
            # actually finished.  This lets the caller's bounded gate wait decide
            # whether a last-resort service recovery is needed.


def _prepare() -> None:
    global _model
    from voxcpm import VoxCPM
    global _ref_wav, _ref_text
    _ref_wav, _ref_text = _reference()
    common.log(f"VoxCPM2 参考音已就绪 ({len(_ref_text)} chars)")
    common.log(f"加载 VoxCPM2 {_model_path()} …")
    kwargs = dict(load_denoiser=False, local_files_only=True)
    device = __import__("os").environ.get("KXYY_VOXCPM_DEVICE", "").strip()
    if device:
        kwargs["device"] = device
    _model = VoxCPM.from_pretrained(_model_path(), **kwargs)
    try:
        _ensure_prompt_cache()
        common.log("VoxCPM2 参考音 prompt cache 已就绪")
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        common.log("VoxCPM2 prompt cache unavailable; using direct reference encoding")
    common.load_whisper_on_mlx_thread()
    common.log(f"VoxCPM2 就绪 ({OUTPUT_RATE}Hz provider -> {common.OUTPUT_RATE}Hz PCM)")


if __name__ == "__main__":
    cap = silero_shadow.capability_from_environment()
    common.run(
        port=PORT, name="local-voxcpm", synth_tts=_synth,
        synth_tts_stream=_synth_stream, prepare=_prepare, tts_pool=_pool,
        tts_parallelism=1, tts_prefetch_while_playing=False,
        system_suffix=common.CONTINUE_CONVERSATION_SUFFIX,
        vad_shadow_pipeline_factory=cap.pipeline_factory(),
        vad_shadow_start_status=cap.status, vad_shadow_mode=cap.mode,
        vad_shadow_config_revision=getattr(cap, "config_revision", "none"),
    )
