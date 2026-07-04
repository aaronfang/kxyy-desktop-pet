#!/usr/bin/env python3
"""探测火山端到端实时语音是否能用当前 settings 接通（不采麦、不播音）。"""

from __future__ import annotations

import asyncio
import json
import ssl
import struct
import sys
import uuid
from pathlib import Path

SETTINGS = (
    Path.home()
    / "Library/Application Support/com.aaronfang.kxyydesktoppet/settings.json"
)

ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
RESOURCE_ID = "volc.speech.dialog"
APP_KEY = "PlgvMymc7f3tQnJ6"
MODEL_VERSION = "1.2.1.1"

EV_START_CONNECTION = 1
EV_FINISH_CONNECTION = 2
EV_START_SESSION = 100
EV_FINISH_SESSION = 102
EV_CONNECTION_STARTED = 50
EV_CONNECTION_FAILED = 51
EV_SESSION_STARTED = 150
EV_SESSION_FINISHED = 152
EV_SESSION_FAILED = 153

EVENT_NAMES = {
    EV_CONNECTION_STARTED: "ConnectionStarted",
    EV_CONNECTION_FAILED: "ConnectionFailed",
    EV_SESSION_STARTED: "SessionStarted",
    EV_SESSION_FINISHED: "SessionFinished",
    EV_SESSION_FAILED: "SessionFailed",
}


def load_cfg() -> tuple[str, str, str]:
    s = json.loads(SETTINGS.read_text(encoding="utf-8"))
    app_id = (s.get("realtimeAppId") or "").strip()
    access_key = (s.get("realtimeAccessKey") or "").strip()
    speaker = (s.get("realtimeVoice") or s.get("ttsVoice") or "").strip()
    if not app_id or not access_key:
        raise SystemExit("settings 缺少 realtimeAppId / realtimeAccessKey")
    if not speaker.startswith("S_"):
        raise SystemExit(f"需要 S_ 复刻音色，当前 speaker={speaker!r}")
    return app_id, access_key, speaker


def build_full_client(event: int, session_id: str | None, payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    buf = bytearray()
    buf.append(0x11)
    buf.append(0x14)  # FULL_CLIENT | FLAG_WITH_EVENT
    buf.append(0x10)  # JSON | no compression
    buf.append(0x00)
    buf.extend(struct.pack(">i", event))
    if session_id is not None:
        sid = session_id.encode("utf-8")
        buf.extend(struct.pack(">I", len(sid)))
        buf.extend(sid)
    buf.extend(struct.pack(">I", len(body)))
    buf.extend(body)
    return bytes(buf)


def parse_server_frame(data: bytes) -> tuple[int | None, dict | None, str | None]:
    """返回 (event, payload_json, error_text)。"""
    if len(data) < 4:
        return None, None, "帧太短"
    msg_type = (data[1] >> 4) & 0x0F
    flags = data[1] & 0x0F
    serialization = (data[2] >> 4) & 0x0F
    compression = data[2] & 0x0F
    off = 4

    if msg_type == 0b1111:  # error
        if len(data) < off + 8:
            return None, None, "错误帧不完整"
        code = struct.unpack(">i", data[off : off + 4])[0]
        off += 4
        # 可能还有 session / payload
        try:
            plen = struct.unpack(">I", data[off : off + 4])[0]
            off += 4
            msg = data[off : off + plen].decode("utf-8", errors="replace")
        except Exception:
            msg = data[off:].decode("utf-8", errors="replace")
        return None, None, f"服务端错误 code={code} {msg}"

    event = None
    if flags & 0b0100:
        if len(data) < off + 4:
            return None, None, "缺 event"
        event = struct.unpack(">i", data[off : off + 4])[0]
        off += 4

    # 可选 session_id
    if event in (
        EV_SESSION_STARTED,
        EV_SESSION_FINISHED,
        EV_SESSION_FAILED,
        EV_START_SESSION,
        EV_FINISH_SESSION,
    ) or (flags & 0b0100 and event and event >= 100):
        if len(data) >= off + 4:
            slen = struct.unpack(">I", data[off : off + 4])[0]
            off += 4
            if slen > 0 and len(data) >= off + slen:
                off += slen

    payload = None
    if len(data) >= off + 4:
        plen = struct.unpack(">I", data[off : off + 4])[0]
        off += 4
        raw = data[off : off + plen]
        if compression == 1:
            import gzip

            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
        if serialization == 1 and raw:
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                payload = {"_raw": raw[:200].decode("utf-8", errors="replace")}

    return event, payload, None


async def main() -> None:
    try:
        import websockets
    except ImportError:
        print("请先: scripts/voice-ab/.venv/bin/pip install websockets", file=sys.stderr)
        raise SystemExit(1)

    app_id, access_key, speaker = load_cfg()
    print(f"App ID: {app_id}")
    print(f"Speaker: {speaker}")
    print(f"Model: {MODEL_VERSION}")
    print(f"连接 {ENDPOINT} …")

    headers = {
        "X-Api-App-ID": app_id,
        "X-Api-Access-Key": access_key,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-App-Key": APP_KEY,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }
    ssl_ctx = ssl._create_unverified_context()
    session_id = str(uuid.uuid4())

    async with websockets.connect(
        ENDPOINT,
        additional_headers=headers,
        ssl=ssl_ctx,
        open_timeout=15,
        max_size=8 * 1024 * 1024,
    ) as ws:
        print("WS 已连接，发送 StartConnection …")
        await ws.send(build_full_client(EV_START_CONNECTION, None, {}))

        got_conn = False
        got_sess = False
        deadline = asyncio.get_event_loop().time() + 12

        start_session_payload = {
            "tts": {
                "audio_config": {
                    "channel": 1,
                    "format": "pcm_s16le",
                    "sample_rate": 24000,
                },
                "speaker": speaker,
            },
            "asr": {
                "extra": {
                    "enable_asr_twopass": True,
                }
            },
            "dialog": {
                "bot_name": "元元",
                "system_role": "你是元元，简短口语化回复，一两句即可。",
                "extra": {
                    "input_mod": "keep_alive",
                    "model": MODEL_VERSION,
                },
            },
        }

        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                if got_sess:
                    break
                continue
            if not isinstance(msg, (bytes, bytearray)):
                print(f"  文本帧: {msg!r}")
                continue
            event, payload, err = parse_server_frame(bytes(msg))
            if err:
                print(f"FAIL: {err}")
                if payload:
                    print(json.dumps(payload, ensure_ascii=False, indent=2))
                raise SystemExit(2)
            name = EVENT_NAMES.get(event, str(event))
            print(f"  ← event {name} ({event}) payload={payload}")
            if event == EV_CONNECTION_STARTED and not got_conn:
                got_conn = True
                print("发送 StartSession …")
                await ws.send(
                    build_full_client(EV_START_SESSION, session_id, start_session_payload)
                )
            elif event == EV_SESSION_STARTED:
                got_sess = True
                print("OK: 会话已建立，发送 FinishSession …")
                await ws.send(build_full_client(EV_FINISH_SESSION, session_id, {}))
            elif event in (EV_CONNECTION_FAILED, EV_SESSION_FAILED):
                print("FAIL: 会话/连接失败")
                raise SystemExit(2)
            elif event == EV_SESSION_FINISHED:
                break

        if not got_conn:
            print("FAIL: 未收到 ConnectionStarted")
            raise SystemExit(2)
        if not got_sess:
            print("FAIL: 未收到 SessionStarted（检查 App ID / Access Key / S_ 音色是否开通实时对话）")
            raise SystemExit(2)

        try:
            await ws.send(build_full_client(EV_FINISH_CONNECTION, None, {}))
        except Exception:
            pass
        print("探测成功：火山实时语音可接通。")


if __name__ == "__main__":
    asyncio.run(main())
