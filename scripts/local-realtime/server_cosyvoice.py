#!/usr/bin/env python3
"""本地语音 · CosyVoice 情绪/语气（通话 WS :19877，朗读 HTTP :19977）。

ASR/打断逻辑与 Qwen 入口相同；TTS 走 DashScope CosyVoice（instruction）。
朗读与通话共用同一后端。

用法：
  scripts/voice-ab/.venv/bin/python scripts/local-realtime/server_cosyvoice.py
  设置「语音后端」= CosyVoice（通义）
  需填写 qwenVlKey + cosyvoiceVoice（cosyvoice-… 复刻音色）
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import common
import tts_cosyvoice

PORT = 19877
_tts_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cosy-tts")


def prepare() -> None:
    tts_cosyvoice.configure_from_settings()
    common._mlx_pool.submit(common.load_whisper_on_mlx_thread).result()
    common.log("CosyVoice 实时服务就绪")


if __name__ == "__main__":
    common.run(
        port=PORT,
        name="local-cosy",
        synth_tts=tts_cosyvoice.synth_tts,
        synth_tts_http=tts_cosyvoice.synth_tts_http,
        prepare=prepare,
        tts_pool=_tts_pool,
        tts_parallelism=2,
        tts_prefetch_while_playing=True,
        system_suffix=tts_cosyvoice.SYSTEM_SUFFIX,
    )
