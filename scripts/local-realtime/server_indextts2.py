#!/usr/bin/env python3
"""本地语音 · IndexTTS-2 开源权重（通话 WS :9879，朗读 HTTP :9979）。

ASR/打断与其它本地入口相同；TTS 走本机 IndexTTS-2（零样本复刻 + 文本情绪）。
面向 Windows + NVIDIA；macOS 请用本地 Qwen3-TTS。

用法：
  python scripts/local-realtime/server_indextts2.py
  设置「语音后端」= IndexTTS-2 本地开源

准备：
  1. git clone --recursive https://github.com/index-tts/index-tts.git \\
       scripts/local-realtime/index-tts
  2. 按其 README 安装依赖（独立 venv，需 CUDA）
  3. 下载 checkpoints 到
       scripts/local-realtime/pretrained_models/IndexTTS-2
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import common
import tts_indextts2

PORT = 9879
_tts_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="itts2")


def prepare() -> None:
    tts_indextts2.configure_from_settings()
    try:
        common._mlx_pool.submit(common.load_whisper_on_mlx_thread).result()
    except Exception as e:
        common.log(f"警告：Whisper 加载失败，通话 ASR 不可用：{e}")
        common.log("朗读 HTTP 仍可用。")
    common.log("IndexTTS-2 本地服务就绪")


if __name__ == "__main__":
    common.run(
        port=PORT,
        name="local-itts2",
        synth_tts=tts_indextts2.synth_tts,
        synth_tts_http=tts_indextts2.synth_tts_http,
        prepare=prepare,
        tts_pool=_tts_pool,
        system_suffix=tts_indextts2.SYSTEM_SUFFIX,
    )
