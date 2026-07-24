#!/usr/bin/env python3
"""Qwen3-TTS 官方 PyTorch 后端（跨平台，面向 Windows / Linux）。

macOS(Apple Silicon) 走 mlx-audio（见 server.py）；本模块用阿里官方 `qwen-tts`
（PyTorch），默认加载 1.7B 参数模型 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`，做零样本语音克隆。

准备（建议独立 venv：scripts/local-realtime/.venv-qwen3）：
  1. 按 https://pytorch.org 安装匹配的 torch（NVIDIA 选对应 CUDA 版本；无 GPU 亦可 CPU，较慢）
  2. pip install -U qwen-tts soundfile websockets certifi openai-whisper
     （openai-whisper 仅实时通话的 ASR 需要；仅朗读可不装）
  也可直接运行 scripts/windows/setup-qwen3-tts.ps1 自动配置。

settings.json（可选）：
  qwen3ModelDir   本地权重目录，或 HF/ModelScope 模型 id（默认 Qwen/Qwen3-TTS-12Hz-1.7B-Base）
  qwen3Language   合成语言（Auto / Chinese / English …），默认 Auto

参考音：优先 settings.localRefWav / localRefText；留空则按 settings.personaCardId
从 scripts/local-realtime/assets/<cardId>/ref.* 加载（默认卡 kxyy-yuanyuan）。
"""

from __future__ import annotations

import os
from pathlib import Path

import common

# 默认 1.7B 参数模型（首次运行自动下载，约数 GB）。
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"

_model = None
_prompt = None
_ref_wav: "Path | None" = None
_ref_text = ""
_language = "Auto"

# 朗读文本清洗（去神态括号、规范省略号）与 common 共用；Base 模型不支持情绪指令，
# 故仅做文本清洗，不注入情绪描述。
text_for_speech = common.text_for_speech


def _resolve_model() -> str:
    """settings.qwen3ModelDir / 环境变量 → 本地目录（绝对路径）或 HF/ModelScope 模型 id。"""
    s = common.load_settings()
    raw = (s.get("qwen3ModelDir") or os.environ.get("QWEN3_TTS_MODEL") or "").strip()
    if not raw:
        return DEFAULT_MODEL
    p = Path(raw).expanduser()
    if not p.is_absolute():
        cand = (common.REPO / p)
        if cand.exists():
            return str(cand.resolve())
    if p.exists():
        return str(p)
    # 既非现存本地目录，则按模型 id 交给 from_pretrained 自动下载。
    return raw


def configure_from_settings() -> None:
    global _model, _prompt, _ref_wav, _ref_text, _language
    s = common.load_settings()
    _language = (
        (s.get("qwen3Language") or os.environ.get("QWEN3_TTS_LANG") or "Auto").strip()
        or "Auto"
    )

    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as e:
        raise SystemExit(
            "未安装 Qwen3-TTS 的 PyTorch 依赖（qwen-tts / torch）。\n"
            "请在语音 venv 里执行：\n"
            "  pip install -U qwen-tts soundfile websockets certifi\n"
            "并按 https://pytorch.org 安装匹配的 torch（NVIDIA 选对应 CUDA 版本）。\n"
            "或直接运行 scripts/windows/setup-qwen3-tts.ps1 自动配置。\n"
            f"原始错误：{e}"
        ) from e

    model_id = _resolve_model()
    _ref_wav, _ref_text = common.ensure_ref_wav()
    common.log(f"参考音已就绪 ({len(_ref_text)} chars)")

    has_cuda = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())
    if has_cuda:
        device_map = "cuda:0"
        dtype = torch.bfloat16
    else:
        device_map = "cpu"
        dtype = torch.float32
        common.log("警告：未检测到 CUDA，Qwen3-TTS 将在 CPU 上运行（速度较慢）。")

    # flash-attn 在 Windows 上难装，默认用 sdpa；可用 QWEN3_TTS_ATTN 覆盖。
    attn = (os.environ.get("QWEN3_TTS_ATTN", "sdpa") or "sdpa").strip()

    common.log(f"加载 Qwen3-TTS {model_id}（device={device_map} dtype={dtype} attn={attn}）…")
    try:
        _model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device_map,
            dtype=dtype,
            attn_implementation=attn,
        )
    except Exception as e:
        # 某些环境不支持 sdpa / flash_attention_2，回退到库默认注意力实现。
        common.log(f"attn_implementation={attn} 加载失败（{e}），回退默认实现重试…")
        _model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device_map,
            dtype=dtype,
        )

    # 预构建参考音 prompt，避免每次合成重复提取说话人特征。
    try:
        _prompt = _model.create_voice_clone_prompt(
            ref_audio=str(_ref_wav),
            ref_text=_ref_text,
            x_vector_only_mode=not bool(_ref_text),
        )
        common.log("参考音 prompt 就绪")
    except Exception as e:
        _prompt = None
        common.log(f"预构建参考音 prompt 失败（改为每次合成时传参）：{e}")

    common.log(f"Qwen3-TTS 就绪 (pytorch) model={model_id} lang={_language}")


def _wav_to_pcm24k(audio, sr: int) -> bytes:
    """模型输出（float 波形 + 采样率）→ 24k 单声道 PCM16 bytes。"""
    import numpy as np

    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if a.size == 0:
        return b""
    if sr != common.OUTPUT_RATE and a.size > 1:
        n = max(1, int(round(a.size * common.OUTPUT_RATE / sr)))
        x_old = np.linspace(0.0, 1.0, num=a.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        a = np.interp(x_new, x_old, a).astype(np.float32)
    a = np.clip(a, -1.0, 1.0)
    return (a * 32767.0).astype(np.int16).tobytes()


def synth_tts(text: str) -> bytes:
    if _model is None or _ref_wav is None:
        raise RuntimeError("Qwen3-TTS 未加载")
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return b""

    common.log(f"Qwen3-TTS chars={len(spoken)} lang={_language}")
    kwargs = dict(text=spoken, language=_language)
    if _prompt is not None:
        kwargs["voice_clone_prompt"] = _prompt
    else:
        kwargs["ref_audio"] = str(_ref_wav)
        kwargs["ref_text"] = _ref_text

    wavs, sr = _model.generate_voice_clone(**kwargs)
    if not wavs:
        return b""
    return _wav_to_pcm24k(wavs[0], int(sr))


def synth_tts_http(text: str) -> "tuple[bytes, str]":
    pcm = synth_tts(text)
    if not pcm:
        raise RuntimeError("Qwen3-TTS 未返回音频")
    return common.pcm16_to_browser_wav(pcm, common.OUTPUT_RATE), "audio/wav"
