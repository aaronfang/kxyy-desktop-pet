#!/usr/bin/env python3
"""本地语音 · Qwen3-TTS 复刻（通话 WS :9876，朗读 HTTP :9976）。

用法：
  scripts/voice-ab/.venv/bin/python scripts/local-realtime/server.py
  设置「语音后端」= 本地 Qwen3-TTS（朗读与通话共用）
"""

from __future__ import annotations

import common

PORT = 9876
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"

_tts_model = None
_ref_text = ""
_ref_wav = None


def _load_on_mlx() -> None:
    global _tts_model, _ref_text, _ref_wav
    _ref_wav, _ref_text = common.ensure_ref_wav()
    common.log(f"参考音 {_ref_wav} ({len(_ref_text)} chars)")
    common.log(f"加载 TTS {TTS_MODEL} …")
    from mlx_audio.tts.utils import load_model

    _tts_model = load_model(TTS_MODEL)
    common.load_whisper_on_mlx_thread()
    common.log("Qwen3-TTS 就绪")


def prepare() -> None:
    common._mlx_pool.submit(_load_on_mlx).result()


def synth_tts(text: str) -> bytes:
    import numpy as np

    results = list(
        _tts_model.generate(
            text=text,
            ref_audio=str(_ref_wav),
            ref_text=_ref_text,
        )
    )
    if not results:
        return b""
    audio = np.array(results[0].audio, dtype=np.float32).reshape(-1)
    sr = int(
        getattr(results[0], "sample_rate", None)
        or getattr(_tts_model, "sample_rate", 24000)
    )
    if sr != common.OUTPUT_RATE and len(audio) > 1:
        duration = len(audio) / sr
        n = max(1, int(duration * common.OUTPUT_RATE))
        x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype(np.int16).tobytes()


if __name__ == "__main__":
    common.run(
        port=PORT,
        name="local-qwen",
        synth_tts=synth_tts,
        prepare=prepare,
        tts_pool=common._mlx_pool,
    )
