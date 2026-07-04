#!/usr/bin/env python3
"""本地语音 · Fun-CosyVoice3 开源权重（通话 WS :9878，朗读 HTTP :9978）。

ASR/打断逻辑与其它本地入口相同；TTS 走本机 CosyVoice3 权重（零样本复刻 + instruct 情绪）。
不消耗通义 / 火山 token。对话仍用 DeepSeek Key。

用法：
  # 建议在 CosyVoice 官方环境中启动（需已 clone 权重与依赖）
  python scripts/local-realtime/server_cosyvoice3_local.py

  设置「语音后端」= CosyVoice3 本地开源

准备：
  1. git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git \\
       scripts/local-realtime/CosyVoice
  2. 按其 README 安装依赖（NVIDIA GPU 推荐）
  3. 下载 Fun-CosyVoice3-0.5B 到
       scripts/local-realtime/pretrained_models/Fun-CosyVoice3-0.5B
  4. 参考音默认用 voice-ab 元元片段（与本地 Qwen 相同）
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import common
import tts_cosyvoice3_local

PORT = 9878
_tts_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cv3-tts")


def prepare() -> None:
    tts_cosyvoice3_local.configure_from_settings()
    # Whisper 仍走 MLX（Apple Silicon）；若在 Linux+CUDA 机器上无 mlx，可后续换 faster-whisper。
    try:
        common._mlx_pool.submit(common.load_whisper_on_mlx_thread).result()
    except Exception as e:
        common.log(f"警告：Whisper(MLX) 加载失败，通话 ASR 不可用：{e}")
        common.log("朗读 HTTP 仍可用；通话需本机可跑 mlx-whisper，或改用其它机器。")
    common.log("CosyVoice3 本地服务就绪")


if __name__ == "__main__":
    common.run(
        port=PORT,
        name="local-cv3",
        synth_tts=tts_cosyvoice3_local.synth_tts,
        synth_tts_http=tts_cosyvoice3_local.synth_tts_http,
        prepare=prepare,
        tts_pool=_tts_pool,
        system_suffix=tts_cosyvoice3_local.SYSTEM_SUFFIX,
    )
