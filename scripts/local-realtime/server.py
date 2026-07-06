#!/usr/bin/env python3
"""本地语音 · Qwen3-TTS（跨平台，通话 WS :9876，朗读 HTTP :9976）。

后端按平台自动选择：
  - macOS(Apple Silicon)：mlx-audio（mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit）。
  - Windows / Linux：官方 PyTorch 包 qwen-tts（默认 Qwen/Qwen3-TTS-12Hz-1.7B-Base），
    见 tts_qwen3_torch.py。Windows 首次使用请先运行 scripts/windows/setup-qwen3-tts.ps1。

用法：
  <venv>/python scripts/local-realtime/server.py
  设置「语音后端」= 本地 Qwen3-TTS（朗读与通话共用）
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor

import common

PORT = 9876
# macOS MLX 量化权重（0.6B）；PyTorch 路径的模型见 tts_qwen3_torch.DEFAULT_MODEL。
TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"


def _mlx_available() -> bool:
    """仅 macOS 且已安装 mlx-audio 时用 MLX；否则回退 PyTorch（Windows/Linux）。"""
    if sys.platform != "darwin":
        return False
    try:
        import mlx_audio  # noqa: F401

        return True
    except Exception:
        return False


# ============================ MLX 路径（macOS）============================
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
    common.log("Qwen3-TTS 就绪 (mlx)")


def _prepare_mlx() -> None:
    common._mlx_pool.submit(_load_on_mlx).result()


def _synth_mlx(text: str) -> bytes:
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


# ====================== 入口：按平台选择后端拉起服务 ======================
def _run_mlx() -> None:
    common.run(
        port=PORT,
        name="local-qwen",
        synth_tts=_synth_mlx,
        prepare=_prepare_mlx,
        tts_pool=common._mlx_pool,
    )


def _run_torch() -> None:
    import tts_qwen3_torch as qwen3

    tts_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen3")

    def prepare() -> None:
        qwen3.configure_from_settings()
        # 通话 ASR：Windows/Linux 用 openai-whisper（无 mlx-whisper）。缺失不阻断朗读。
        try:
            common._mlx_pool.submit(common.load_whisper_on_mlx_thread).result()
        except Exception as e:
            common.log(f"警告：Whisper 加载失败，实时通话 ASR 不可用：{e}")
            common.log("朗读 HTTP 仍可用（如需通话请安装 openai-whisper）。")
        common.log("Qwen3-TTS 本地服务就绪 (pytorch)")

    common.run(
        port=PORT,
        name="local-qwen",
        synth_tts=qwen3.synth_tts,
        synth_tts_http=qwen3.synth_tts_http,
        prepare=prepare,
        tts_pool=tts_pool,
    )


if __name__ == "__main__":
    if _mlx_available():
        _run_mlx()
    else:
        _run_torch()
