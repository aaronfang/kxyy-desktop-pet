#!/usr/bin/env python3
"""DashScope CosyVoice 复刻 TTS（WebSocket），支持自然语言情绪 instruction。

协议对齐上游 kxyy_ai_clone /api/tts CosyVoice 分支。
需要 settings.json：
  qwenVlKey          DashScope API Key
  cosyvoiceVoice     复刻音色 id（cosyvoice-…）
  cosyvoiceModel     默认 cosyvoice-v3.5-flash（支持 instruction）
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl
import uuid
from typing import Any

import common

WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
DEFAULT_MODEL = "cosyvoice-v3.5-flash"
TIMEOUT_S = 45

# 支持任意自然语言 instruction 的模型（与上游白名单一致）
INSTRUCT_MODELS = {
    "cosyvoice-v3.5-plus",
    "cosyvoice-v3.5-flash",
    "cosyvoice-v3-flash",
}

# 情绪只描述「感情」，不指挥语速/口吃（后者交给复刻音色自身韵律）
EMOTION_INSTRUCTIONS = {
    "excited": "语气开心一点，自然上扬。",
    "angry": "语气有点生气，但别夸张。",
    "sad": "语气有点难过，轻轻的。",
    "gentle": "语气温柔一点。",
    "shy": "语气害羞小声一点。",
    "neutral": "",
}

# 相对人物基线 rate 的情绪微调（基线来自原声分析）
EMOTION_RATE_DELTA = {
    "excited": 0.04,
    "angry": 0.03,
    "sad": -0.06,
    "gentle": -0.03,
    "shy": -0.04,
    "neutral": 0.0,
}

# LLM：短句口语；停顿用标点即可，不要硬写口吃（易假）
SYSTEM_SUFFIX = (
    "\n口语化一两句，像真人闲聊；需要停顿时用逗号或……；"
    "可带神态括号如（开心）（小声）（生气）（难过），括号不会被念出。"
)

STYLE_PATH = common.ROOT / "out" / "voice_style.json"

_style: dict = {
    "suggested_rate": 0.96,
    "pause_hint": True,
    "chars_per_sec": 4.6,
}


def _instruct_units(s: str) -> int:
    n = 0
    for ch in s:
        n += 2 if "\u4e00" <= ch <= "\u9fff" else 1
    return n


def _clip_instruct(s: str, max_units: int = 100) -> str:
    if _instruct_units(s) <= max_units:
        return s
    out = []
    n = 0
    for ch in s:
        u = 2 if "\u4e00" <= ch <= "\u9fff" else 1
        if n + u > max_units:
            break
        out.append(ch)
        n += u
    return "".join(out)


def load_voice_style() -> dict:
    """读取 extract_style.py 从原声提取的节奏特征。"""
    global _style
    if STYLE_PATH.exists():
        try:
            _style = json.loads(STYLE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return _style


def build_instruction(emotion: str) -> str:
    """复刻音色已含人物韵律；instruction 只补情绪，中性不下发，避免人机腔。"""
    emo = (EMOTION_INSTRUCTIONS.get(emotion) or "").strip()
    return _clip_instruct(emo) if emo else ""


def base_rate_for(emotion: str) -> float:
    base = float(_style.get("suggested_rate") or 0.96)
    delta = float(EMOTION_RATE_DELTA.get(emotion, 0.0))
    return max(0.75, min(1.08, base + delta))

_api_key = ""
_voice = ""
_model = DEFAULT_MODEL


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
    if has(r"开心|高兴|兴奋|哈哈+|嘿嘿|耶+|太好了|好耶|哇+|嘻嘻|冲鸭|棒") or bangs >= 2 or re.search(
        r"[~～]", t
    ):
        return "excited"
    return "neutral"


def text_for_speech(raw: str) -> str:
    """去掉神态括号，保留……与顿号口吃，便于节奏表演。"""
    t = re.sub(r"（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*", "", str(raw or ""))
    # 规范省略号，帮助模型拉长停顿
    t = t.replace("...", "……").replace("。。。", "……")
    t = re.sub(r"[~～]{2,}", "～", t)
    t = re.sub(r"[ \t]+", " ", t).strip()
    return t


def configure_from_settings() -> None:
    global _api_key, _voice, _model
    s = common.load_settings()
    _api_key = (s.get("qwenVlKey") or "").strip()
    _voice = (s.get("cosyvoiceVoice") or "").strip()
    _model = (s.get("cosyvoiceModel") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if not _api_key:
        raise SystemExit("settings.json 未配置 qwenVlKey（DashScope，CosyVoice 用）")
    if not _voice.startswith("cosyvoice-"):
        raise SystemExit(
            "settings.json 未配置 cosyvoiceVoice（需 cosyvoice- 开头的复刻音色 id）。\n"
            "在阿里云百炼 / DashScope 声音复刻创建音色后填入设置页。"
        )
    style = load_voice_style()
    common.log(
        f"CosyVoice voice={_voice} model={_model} "
        f"rate={style.get('suggested_rate')} cps={style.get('chars_per_sec')} "
        f"pause={style.get('avg_pause_s')}s"
    )


async def _synthesize_mp3(text: str, *, instruction: str, rate, pitch, volume) -> tuple[bytes, int]:
    """返回 (mp3_bytes, billed_characters)。计费字符来自上游 usage.characters。"""
    import websockets

    task_id = str(uuid.uuid4())
    chunks: list[bytes] = []
    started = False
    usage_chars = 0
    params: dict[str, Any] = {
        "text_type": "PlainText",
        "voice": _voice,
        "format": "mp3",
        "sample_rate": 22050,
    }
    # rate 来自人物原声分析，始终下发；instruction 只补情绪（可为空）
    if instruction:
        params["instruction"] = instruction
    if rate is not None:
        params["rate"] = rate
    if pitch is not None:
        params["pitch"] = pitch
    if volume is not None:
        params["volume"] = volume

    ssl_ctx = ssl._create_unverified_context()
    async with websockets.connect(
        WS_URL,
        additional_headers={"Authorization": f"Bearer {_api_key}"},
        ssl=ssl_ctx,
        open_timeout=15,
        max_size=8 * 1024 * 1024,
    ) as ws:
        await ws.send(
            json.dumps(
                {
                    "header": {
                        "action": "run-task",
                        "task_id": task_id,
                        "streaming": "duplex",
                    },
                    "payload": {
                        "task_group": "audio",
                        "task": "tts",
                        "function": "SpeechSynthesizer",
                        "model": _model,
                        "parameters": params,
                        "input": {},
                    },
                }
            )
        )

        async def reader() -> None:
            nonlocal started, usage_chars
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    chunks.append(bytes(message))
                    continue
                try:
                    evt = json.loads(message)
                except json.JSONDecodeError:
                    continue
                event = (evt.get("header") or {}).get("event")
                # result-generated / task-finished 可能带累计计费字符，取最后一次。
                usage = (evt.get("payload") or {}).get("usage") or {}
                chars = usage.get("characters")
                if isinstance(chars, (int, float)) and chars > 0:
                    usage_chars = int(chars)
                if event == "task-started" and not started:
                    started = True
                    await ws.send(
                        json.dumps(
                            {
                                "header": {
                                    "action": "continue-task",
                                    "task_id": task_id,
                                    "streaming": "duplex",
                                },
                                "payload": {"input": {"text": text}},
                            }
                        )
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "header": {
                                    "action": "finish-task",
                                    "task_id": task_id,
                                    "streaming": "duplex",
                                },
                                "payload": {"input": {}},
                            }
                        )
                    )
                elif event == "task-finished":
                    return
                elif event == "task-failed":
                    msg = (evt.get("header") or {}).get("error_message") or "task-failed"
                    raise RuntimeError(msg)

        await asyncio.wait_for(reader(), timeout=TIMEOUT_S)

    if not chunks:
        raise RuntimeError("CosyVoice 未返回音频")
    # 上游偶发不带 usage：按 CosyVoice 计费规则估算（CJK=2，其它=1）。
    if usage_chars <= 0:
        usage_chars = _instruct_units(text)
    return b"".join(chunks), usage_chars


def _split_speech_chunks(text: str, max_chunk: int = 48) -> list[str]:
    """按句切开，避免单次请求过长导致慢/糊。"""
    t = (text or "").strip()
    if not t:
        return []
    parts = re.split(r"(?<=[。！？；\n])", t)
    chunks: list[str] = []
    buf = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if not buf:
            buf = p
        elif len(buf) + len(p) <= max_chunk:
            buf += p
        else:
            chunks.append(buf)
            buf = p
        # 单句本身超长则硬切
        while len(buf) > max_chunk:
            chunks.append(buf[:max_chunk])
            buf = buf[max_chunk:]
    if buf:
        chunks.append(buf)
    return chunks


def _synth_mp3_once(spoken: str, *, emotion: str) -> tuple[bytes, int]:
    instruction = ""
    rate = base_rate_for(emotion)
    pitch = volume = None
    if _model in INSTRUCT_MODELS:
        instruction = build_instruction(emotion)
    common.log(
        f"CosyVoice emotion={emotion} rate={rate:.3f} "
        f"chars={len(spoken)} instruct={instruction!r}"
    )
    return asyncio.run(
        _synthesize_mp3(
            spoken, instruction=instruction, rate=rate, pitch=pitch, volume=volume
        )
    )


def synth_tts_mp3(text: str) -> tuple[bytes, int]:
    """合成 MP3（可多句拼接）。返回 (mp3, 累计计费字符)。"""
    emotion = detect_emotion(text)
    spoken = text_for_speech(text) or (text or "").strip()
    spoken = common.clip_speech_text(spoken)
    if not spoken:
        return b"", 0
    chunks = _split_speech_chunks(spoken)
    if not chunks:
        return b"", 0
    parts: list[bytes] = []
    billed = 0
    for i, chunk in enumerate(chunks):
        # 首句带情绪，后续句保持中性，避免指令叠加发飘
        em = emotion if i == 0 else "neutral"
        audio, chars = _synth_mp3_once(chunk, emotion=em)
        parts.append(audio)
        billed += chars
    return b"".join(parts), billed


def synth_tts_http(text: str) -> tuple[bytes, str, dict | None]:
    """桌面端朗读：直接返回 audio/mpeg；第三项为计费用量（供 debug）。"""
    mp3, billed = synth_tts_mp3(text)
    if not mp3:
        raise RuntimeError("CosyVoice 未返回音频")
    usage = {"characters": billed, "provider": "CosyVoice"} if billed > 0 else None
    return mp3, "audio/mpeg", usage


def synth_tts(text: str) -> tuple[bytes, dict]:
    """实时通话入口：MP3 → PCM16 24k；附带计费字符供 debug。"""
    mp3, billed = synth_tts_mp3(text)
    if not mp3:
        return b"", {}
    return common.mp3_to_pcm24k(mp3), {"characters": billed, "provider": "CosyVoice"}
