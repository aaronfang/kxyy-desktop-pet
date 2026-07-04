#!/usr/bin/env python3
"""Fun-CosyVoice3 本地开源权重 TTS（零样本复刻 + instruct 情绪）。

依赖（需自行准备，建议 NVIDIA GPU + 独立 venv/conda）：
  1. 克隆源码：
       git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git \\
         scripts/local-realtime/CosyVoice
  2. 按 CosyVoice/README 安装依赖
  3. 下载权重到（默认路径）：
       scripts/local-realtime/pretrained_models/Fun-CosyVoice3-0.5B
     或 ModelScope / HuggingFace：FunAudioLLM/Fun-CosyVoice3-0.5B-2512

settings.json（可选）：
  cosyvoice3ModelDir  权重目录
  cosyvoice3RepoDir   CosyVoice 源码目录
  cosyvoice3RefWav    参考音频（默认 voice-ab 元元参考音）
  cosyvoice3RefText   参考音频文案（默认对应 .txt）

参考音默认复用 common.REF_WAV / REF_TXT（与本地 Qwen 相同）。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import common

DEFAULT_MODEL_DIR = common.ROOT / "pretrained_models" / "Fun-CosyVoice3-0.5B"
DEFAULT_REPO_DIR = common.ROOT / "CosyVoice"

# CosyVoice3 instruct：自然语言控情绪/语气
EMOTION_INSTRUCT = {
    "excited": "请用开心兴奋、自然上扬的语气说。",
    "angry": "请用有点生气、但不夸张的语气说。",
    "sad": "请用难过低落、轻轻的语气说。",
    "gentle": "请用温柔安抚、轻声细语的语气说。",
    "shy": "请用害羞小声、略带犹豫的语气说。",
    "neutral": "",
}

SYSTEM_SUFFIX = (
    "\n口语化一两句，像真人闲聊；需要停顿时用逗号或……；"
    "可带神态括号如（开心）（小声）（生气）（难过），括号不会被念出。"
)

_model = None
_sample_rate = 24000
_ref_wav: Path | None = None
_ref_text = ""
_model_dir = ""


def detect_emotion(raw: str) -> str:
    t = str(raw or "")
    cues = " ".join(re.findall(r"（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*", t))
    hay = f"{cues} {t}"

    def has(pat: str) -> bool:
        return re.search(pat, hay) is not None

    if has(r"生气|愤怒|哼|讨厌|可恶|不许|不准|凶|烦死|气死"):
        return "angry"
    if has(r"难过|伤心|委屈|呜+|哭|失落|叹气|对不起|抱歉|心疼"):
        return "sad"
    if has(r"害羞|脸红|小声|不好意思|羞|嘀咕|扭捏"):
        return "shy"
    if has(r"温柔|抱抱|乖|安慰|轻声|摸摸|别怕|没事的|来嘛|乖乖"):
        return "gentle"
    bangs = len(re.findall(r"[!！]", t))
    if (
        has(r"开心|高兴|兴奋|哈哈+|嘿嘿|耶+|太好了|好耶|哇+|嘻嘻|冲鸭|棒")
        or bangs >= 2
        or re.search(r"[~～]", t)
    ):
        return "excited"
    return "neutral"


def text_for_speech(raw: str) -> str:
    t = re.sub(r"（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*", "", str(raw or ""))
    t = t.replace("...", "……").replace("。。。", "……")
    t = re.sub(r"[~～]{2,}", "～", t)
    t = re.sub(r"[ \t]+", " ", t).strip()
    return t


def _resolve_path(raw: str, default: Path) -> Path:
    p = (raw or "").strip()
    if not p:
        return default.expanduser().resolve()
    path = Path(p).expanduser()
    if not path.is_absolute():
        path = (common.REPO / path).resolve()
    return path


def _ensure_import_path(repo_dir: Path) -> None:
    repo = str(repo_dir)
    matcha = str(repo_dir / "third_party" / "Matcha-TTS")
    for p in (matcha, repo):
        if p not in sys.path:
            sys.path.insert(0, p)


def configure_from_settings() -> None:
    global _model, _sample_rate, _ref_wav, _ref_text, _model_dir
    s = common.load_settings()
    model_dir = _resolve_path(s.get("cosyvoice3ModelDir") or "", DEFAULT_MODEL_DIR)
    repo_dir = _resolve_path(
        s.get("cosyvoice3RepoDir") or os.environ.get("COSYVOICE_REPO", ""),
        DEFAULT_REPO_DIR,
    )
    ref_wav = _resolve_path(s.get("cosyvoice3RefWav") or "", common.REF_WAV)
    ref_txt_path = _resolve_path(
        s.get("cosyvoice3RefText") or "",
        common.REF_TXT,
    )

    if not repo_dir.is_dir():
        raise SystemExit(
            f"未找到 CosyVoice 源码目录：{repo_dir}\n"
            "请执行：\n"
            "  git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git "
            f"{DEFAULT_REPO_DIR}\n"
            "并按其 README 安装依赖；或在设置里填写 cosyvoice3RepoDir。"
        )
    if not model_dir.is_dir():
        raise SystemExit(
            f"未找到 CosyVoice3 权重目录：{model_dir}\n"
            "请下载 FunAudioLLM/Fun-CosyVoice3-0.5B-2512 到该路径，"
            "或在设置里填写 cosyvoice3ModelDir。"
        )

    # 参考音：优先设置；否则走 common 的元元参考音（可从 merged.mp3 生成）
    if not ref_wav.is_file():
        ref_wav, auto_text = common.ensure_ref_wav()
        _ref_wav = ref_wav
        _ref_text = auto_text
    else:
        _ref_wav = ref_wav
        if ref_txt_path.is_file():
            _ref_text = ref_txt_path.read_text(encoding="utf-8").strip()
        else:
            # 设置里若直接写了文案（非路径），load 时已是路径解析失败场景，忽略
            _ref_text = ""
        if not _ref_text:
            # 无文案时仍可 zero-shot，但质量会差；给个占位
            _ref_text = "希望你以后能够做的比我还好呦。"
            common.log("警告：未找到参考音文案，使用占位文本，复刻质量可能下降")

    _ensure_import_path(repo_dir)
    common.log(f"加载 CosyVoice3 权重 {_model_dir or model_dir} …")
    try:
        from cosyvoice.cli.cosyvoice import AutoModel
    except ImportError as e:
        raise SystemExit(
            f"无法 import cosyvoice（repo={repo_dir}）：{e}\n"
            "请在 CosyVoice 环境中安装依赖后再启动。"
        ) from e

    _model = AutoModel(model_dir=str(model_dir))
    _sample_rate = int(getattr(_model, "sample_rate", 24000) or 24000)
    _model_dir = str(model_dir)
    common.log(
        f"CosyVoice3 就绪 model={model_dir.name} sr={_sample_rate} "
        f"ref={_ref_wav} prompt_chars={len(_ref_text)}"
    )


def _prompt_text_zero_shot() -> str:
    return f"You are a helpful assistant.<|endofprompt|>{_ref_text}"


def _prompt_text_instruct(emotion: str) -> str:
    inst = (EMOTION_INSTRUCT.get(emotion) or "").strip()
    if not inst:
        return _prompt_text_zero_shot()
    return f"You are a helpful assistant. {inst}<|endofprompt|>"


def _tensor_chunks_to_pcm(chunks: list) -> bytes:
    import numpy as np

    if not chunks:
        return b""
    waves = []
    for item in chunks:
        w = item.get("tts_speech") if isinstance(item, dict) else item
        if w is None:
            continue
        if hasattr(w, "detach"):
            arr = w.detach().float().cpu().numpy()
        else:
            arr = np.asarray(w, dtype=np.float32)
        arr = np.squeeze(arr).astype(np.float32)
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        waves.append(arr)
    if not waves:
        return b""
    audio = np.concatenate(waves)
    sr = _sample_rate
    if sr != common.OUTPUT_RATE and audio.size > 1:
        n = max(1, int(round(audio.size * common.OUTPUT_RATE / sr)))
        x_old = np.linspace(0.0, 1.0, num=audio.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype(np.int16).tobytes()


def _run_inference(spoken: str, emotion: str) -> list:
    assert _model is not None and _ref_wav is not None
    ref = str(_ref_wav)
    # 有情绪走 instruct2；中性走 zero_shot（更稳）
    if emotion and emotion != "neutral" and EMOTION_INSTRUCT.get(emotion):
        prompt = _prompt_text_instruct(emotion)
        common.log(f"CosyVoice3 instruct emotion={emotion} chars={len(spoken)}")
        return list(
            _model.inference_instruct2(spoken, prompt, ref, stream=False)
        )
    prompt = _prompt_text_zero_shot()
    common.log(f"CosyVoice3 zero_shot chars={len(spoken)}")
    return list(
        _model.inference_zero_shot(spoken, prompt, ref, stream=False)
    )


def synth_tts(text: str) -> bytes:
    """实时通话：PCM16 24k。"""
    if _model is None:
        raise RuntimeError("CosyVoice3 未加载")
    emotion = detect_emotion(text)
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return b""
    chunks = _run_inference(spoken, emotion)
    return _tensor_chunks_to_pcm(chunks)


def synth_tts_http(text: str) -> tuple[bytes, str]:
    """朗读：48k WAV，避免 WebView 播 24k 失真。"""
    pcm = synth_tts(text)
    if not pcm:
        raise RuntimeError("CosyVoice3 未返回音频")
    return common.pcm16_to_browser_wav(pcm, common.OUTPUT_RATE), "audio/wav"
