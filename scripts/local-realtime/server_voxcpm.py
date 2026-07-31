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
import threading

import common
import silero_shadow

PORT = 19878
MODEL_DIR = common.REPO / "scripts" / "voxcpm-ab" / "work" / "models" / "VoxCPM2"
OUTPUT_RATE = 48000
FIXED_SEED = 424242
_model = None
_ref_wav = None
_ref_text = ""
_gate = threading.BoundedSemaphore(1)
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voxcpm")
_DONE = object()


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
                cfg_value=2.0, inference_timesteps=10, seed=FIXED_SEED)


def _synth(text: str) -> bytes:
    if not _gate.acquire(blocking=False):
        raise RuntimeError("VoxCPM2 正忙，请稍后再试")
    try:
        return _to_pcm24(_model.generate(**_kwargs(text)))
    finally:
        _gate.release()


def _pull(generator):
    try:
        return next(generator)
    except StopIteration:
        return _DONE


async def _synth_stream(text: str):
    if not _gate.acquire(blocking=False):
        raise RuntimeError("VoxCPM2 正忙，请稍后再试")
    loop = asyncio.get_running_loop()
    generator = None
    try:
        generator = _model.generate_streaming(**_kwargs(text))
        while True:
            chunk = await loop.run_in_executor(_pool, _pull, generator)
            if chunk is _DONE:
                break
            pcm = _to_pcm24(chunk)
            for part in common.chunk_pcm(pcm, 80):
                yield {"type": "audio", "pcm": part}
    finally:
        if generator is not None:
            generator.close()
        _gate.release()


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
    common.load_whisper_on_mlx_thread()
    common.log(f"VoxCPM2 就绪 ({OUTPUT_RATE}Hz provider -> {common.OUTPUT_RATE}Hz PCM)")


if __name__ == "__main__":
    cap = silero_shadow.capability_from_environment()
    common.run(
        port=PORT, name="local-voxcpm", synth_tts=_synth,
        synth_tts_stream=_synth_stream, prepare=_prepare, tts_pool=_pool,
        tts_parallelism=1, tts_prefetch_while_playing=False,
        vad_shadow_pipeline_factory=cap.pipeline_factory(),
        vad_shadow_start_status=cap.status, vad_shadow_mode=cap.mode,
        vad_shadow_config_revision=getattr(cap, "config_revision", "none"),
    )
