#!/usr/bin/env python3
"""IndexTTS-2 本地开源权重 TTS（零样本复刻 + 文本情绪）。

依赖（NVIDIA GPU / Windows 推荐）：
  1. 克隆 https://github.com/index-tts/index-tts
       → scripts/local-realtime/index-tts
  2. 按其 README 安装依赖（独立 venv）
  3. 下载 checkpoints 到
       scripts/local-realtime/pretrained_models/IndexTTS-2
     （内含 config.yaml 与模型权重）

settings.json（可选）：
  indexTts2ModelDir  权重目录（含 config.yaml）
  indexTts2RepoDir   index-tts 源码目录

参考音默认复用 common.REF_WAV（元元片段）。
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

import common

DEFAULT_MODEL_DIR = common.ROOT / "pretrained_models" / "IndexTTS-2"
DEFAULT_REPO_DIR = common.ROOT / "index-tts"

# 文本情绪描述（IndexTTS-2 use_emo_text + emo_text）
EMOTION_TEXT = {
    "excited": "非常开心兴奋，语气上扬活泼。",
    "angry": "有点生气不满，语气加重。",
    "sad": "难过低落，轻轻的。",
    "gentle": "温柔安抚，轻声细语。",
    "shy": "害羞小声，略带犹豫。",
    "neutral": "",
}

SYSTEM_SUFFIX = (
    "\n口语化一两句，像真人闲聊；需要停顿时用逗号或……；"
    "可带神态括号如（开心）（小声）（生气）（难过），括号不会被念出。"
)

_tts = None
_ref_wav: Path | None = None
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


def configure_from_settings() -> None:
    global _tts, _ref_wav, _model_dir
    s = common.load_settings()
    model_dir = _resolve_path(s.get("indexTts2ModelDir") or "", DEFAULT_MODEL_DIR)
    repo_dir = _resolve_path(
        s.get("indexTts2RepoDir") or os.environ.get("INDEX_TTS_REPO", ""),
        DEFAULT_REPO_DIR,
    )

    if not repo_dir.is_dir():
        raise SystemExit(
            f"未找到 IndexTTS-2 源码目录：{repo_dir}\n"
            "请执行：\n"
            f"  git clone --recursive https://github.com/index-tts/index-tts.git {DEFAULT_REPO_DIR}\n"
            "并按其 README 安装依赖；或在设置里填写 indexTts2RepoDir。"
        )
    cfg = model_dir / "config.yaml"
    if not model_dir.is_dir() or not cfg.is_file():
        raise SystemExit(
            f"未找到 IndexTTS-2 权重（需含 config.yaml）：{model_dir}\n"
            "请下载官方 checkpoints 到该目录，或在设置里填写 indexTts2ModelDir。"
        )

    ref_wav, _ref_text = common.ensure_ref_wav()
    _ref_wav = ref_wav

    repo_s = str(repo_dir)
    if repo_s not in sys.path:
        sys.path.insert(0, repo_s)

    common.log(f"加载 IndexTTS-2 权重 {model_dir} …")
    try:
        from indextts.infer_v2 import IndexTTS2
    except ImportError:
        try:
            from indextts import IndexTTS2  # type: ignore
        except ImportError as e:
            raise SystemExit(
                f"无法 import indextts（repo={repo_dir}）：{e}\n"
                "请在 IndexTTS-2 环境中安装依赖后再启动。"
            ) from e

    # Windows+NVIDIA：fp16；无 CUDA 时由库自行回退
    use_fp16 = True
    try:
        import torch

        use_fp16 = bool(torch.cuda.is_available())
    except Exception:
        use_fp16 = False

    _tts = IndexTTS2(
        cfg_path=str(cfg),
        model_dir=str(model_dir),
        use_fp16=use_fp16,
        use_cuda_kernel=False,
        use_deepspeed=False,
    )
    _model_dir = str(model_dir)
    common.log(f"IndexTTS-2 就绪 model={model_dir.name} fp16={use_fp16} ref={_ref_wav}")


def _wav_file_to_pcm24k(path: Path) -> bytes:
    import numpy as np
    import wave

    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise RuntimeError(f"仅支持 16-bit WAV，got sampwidth={sw}")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    audio = audio / 32768.0
    if sr != common.OUTPUT_RATE and audio.size > 1:
        n = max(1, int(round(audio.size * common.OUTPUT_RATE / sr)))
        x_old = np.linspace(0.0, 1.0, num=audio.size, endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype(np.int16).tobytes()


def synth_tts(text: str) -> bytes:
    if _tts is None or _ref_wav is None:
        raise RuntimeError("IndexTTS-2 未加载")
    emotion = detect_emotion(text)
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return b""

    emo_text = EMOTION_TEXT.get(emotion) or ""
    use_emo = bool(emo_text)
    common.log(
        f"IndexTTS-2 emotion={emotion} chars={len(spoken)} emo_text={bool(emo_text)}"
    )

    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    out = Path(tmp)
    try:
        kwargs = dict(
            spk_audio_prompt=str(_ref_wav),
            text=spoken,
            output_path=str(out),
            verbose=False,
        )
        if use_emo:
            kwargs.update(
                use_emo_text=True,
                emo_text=emo_text,
                emo_alpha=0.6,
                use_random=False,
            )
        _tts.infer(**kwargs)
        if not out.is_file() or out.stat().st_size < 44:
            raise RuntimeError("IndexTTS-2 未写出音频")
        return _wav_file_to_pcm24k(out)
    finally:
        out.unlink(missing_ok=True)


def synth_tts_http(text: str) -> tuple[bytes, str]:
    pcm = synth_tts(text)
    if not pcm:
        raise RuntimeError("IndexTTS-2 未返回音频")
    return common.pcm16_to_browser_wav(pcm, common.OUTPUT_RATE), "audio/wav"
