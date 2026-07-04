#!/usr/bin/env python3
"""用本机 settings.json 里的火山 TTS 合成听测样例。"""

from __future__ import annotations

import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

# 部分本机代理/安全软件会注入自签证书，导致默认校验失败。
_SSL_CTX = ssl.create_default_context()
try:
    import certifi  # type: ignore

    _SSL_CTX.load_verify_locations(certifi.where())
except Exception:
    pass
# 仍失败时退回不校验（仅用于本机听测脚本）。
_SSL_CTX_INSECURE = ssl._create_unverified_context()

ROOT = Path(__file__).resolve().parent
PHRASES = ROOT / "phrases.json"
OUT = ROOT / "out" / "volc"
SETTINGS = (
    Path.home()
    / "Library/Application Support/com.aaronfang.kxyydesktoppet/settings.json"
)
VOLC_URL = "https://openspeech.bytedance.com/api/v1/tts"
CLUSTER = "volcano_icl"

EMOTION_MAP = {
    "excited": "happy",
    "angry": "angry",
    "sad": "sad",
    "shy": "shy",
    "gentle": "tender",
    "neutral": "neutral",
}


def load_settings() -> tuple[str, str]:
    if not SETTINGS.exists():
        raise SystemExit(f"找不到设置文件：{SETTINGS}")
    s = json.loads(SETTINGS.read_text(encoding="utf-8"))
    key = (s.get("volcTtsKey") or "").strip()
    voice = (s.get("ttsVoice") or s.get("realtimeVoice") or "").strip()
    if not key:
        raise SystemExit("settings.json 未配置 volcTtsKey")
    if not voice.startswith("S_"):
        raise SystemExit(f"ttsVoice 需为 S_ 开头的复刻音色，当前：{voice!r}")
    return key, voice


def synth_once(api_key: str, voice: str, text: str, emotion: str = "") -> bytes:
    audio: dict = {"voice_type": voice, "encoding": "mp3"}
    if emotion:
        audio["emotion"] = emotion
    payload = {
        "app": {"cluster": CLUSTER},
        "user": {"uid": "kxyy-voice-ab"},
        "audio": audio,
        "request": {
            "reqid": str(uuid.uuid4()),
            "text": text,
            "operation": "query",
        },
    }
    req = urllib.request.Request(
        VOLC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
        },
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=60, context=_SSL_CTX)
    except urllib.error.URLError:
        resp = urllib.request.urlopen(req, timeout=60, context=_SSL_CTX_INSECURE)
    with resp:
        data = json.loads(resp.read().decode("utf-8"))
    code = data.get("code")
    b64 = data.get("data")
    if code != 3000 or not b64:
        msg = data.get("message") or data.get("Message") or ""
        raise RuntimeError(f"火山合成失败 code={code} {msg}")
    return base64.b64decode(b64)


def write_mp3(path: Path, text: str, emotion: str, api_key: str, voice: str) -> float:
    path.parent.mkdir(parents=True, exist_ok=True)
    volc_emotion = EMOTION_MAP.get(emotion, "") if emotion else ""
    t0 = time.perf_counter()
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            audio = synth_once(api_key, voice, text, volc_emotion)
            # 带情绪失败时去掉 emotion 兜底（与桌宠 api.rs 一致）
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            if volc_emotion and attempt == 1:
                volc_emotion = ""
                continue
            time.sleep(0.3 * (attempt + 1))
    else:
        raise last_err or RuntimeError("合成失败")
    elapsed = time.perf_counter() - t0
    path.write_bytes(audio)
    return elapsed


def main() -> None:
    api_key, voice = load_settings()
    phrases = json.loads(PHRASES.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    meta: list[dict] = []

    jobs = [phrases["prompt"], *phrases["items"]]
    print(f"音色 {voice} → {OUT}")
    for job in jobs:
        jid = job["id"]
        text = job["text"]
        emotion = job.get("emotion", "")
        mp3 = OUT / f"{jid}.mp3"
        print(f"  [volc] {jid} …", end="", flush=True)
        try:
            sec = write_mp3(mp3, text, emotion, api_key, voice)
            print(f" ok {sec:.2f}s ({mp3.stat().st_size} bytes)")
            meta.append(
                {
                    "id": jid,
                    "provider": "volc",
                    "path": str(mp3.relative_to(ROOT)),
                    "text": text,
                    "emotion": emotion,
                    "latency_s": round(sec, 3),
                }
            )
        except Exception as e:  # noqa: BLE001
            print(f" FAIL: {e}")
            meta.append({"id": jid, "provider": "volc", "error": str(e)})

    (OUT / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("完成。")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print(f"网络错误：{e}", file=sys.stderr)
        sys.exit(1)
