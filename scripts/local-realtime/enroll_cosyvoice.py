#!/usr/bin/env python3
"""用元元原声在百炼创建 CosyVoice 复刻音色，并写回 settings.json。

流程：本地音频 → 百炼临时 OSS → voice-enrollment → voice_id。

用法：
  scripts/voice-ab/.venv/bin/python scripts/local-realtime/enroll_cosyvoice.py
  scripts/voice-ab/.venv/bin/python scripts/local-realtime/enroll_cosyvoice.py --audio /path/to.wav
  scripts/voice-ab/.venv/bin/python scripts/local-realtime/enroll_cosyvoice.py --target-model cosyvoice-v3.5-plus

样本建议：10~20s、单人、无背景音乐、吐字清晰；默认用 merged.mp3 前 18s。
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
DEFAULT_AUDIO = REPO / "merged.mp3"
SETTINGS = (
    Path.home()
    / "Library/Application Support/com.aaronfang.kxyydesktoppet/settings.json"
)
ENROLL_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
UPLOADS_URL = "https://dashscope.aliyuncs.com/api/v1/uploads"


def _https_context() -> ssl.SSLContext:
    """默认校验证书；仅 KXYY_TTS_INSECURE_SSL=1 时降级为不校验（自担风险）。"""
    if os.environ.get("KXYY_TTS_INSECURE_SSL") == "1":
        print("警告：KXYY_TTS_INSECURE_SSL=1，已关闭 TLS 证书校验", file=sys.stderr)
        return ssl._create_unverified_context()
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def load_settings() -> dict:
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def save_settings(s: dict) -> None:
    SETTINGS.write_text(json.dumps(s, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def api_key(s: dict) -> str:
    key = (s.get("qwenVlKey") or "").strip()
    if not key:
        sys.exit("settings.json 未配置 qwenVlKey")
    return key


def prepare_clip(src: Path, out: Path, seconds: float = 18.0) -> Path:
    """裁一段适合复刻的干净片段（≤60s，推荐 10~20s）。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-ss",
                "0",
                "-t",
                str(seconds),
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "2",
                str(out),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("ffmpeg 裁剪样本超时（120s）") from e
    return out


def http_json(method: str, url: str, headers: dict, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = _https_context()
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err}") from e


def get_upload_policy(key: str, model: str) -> dict:
    url = f"{UPLOADS_URL}?action=getPolicy&model={model}"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    data = http_json("GET", url, headers)
    return data["data"]


def upload_to_oss(policy: dict, file_path: Path) -> str:
    import requests

    file_name = file_path.name
    oss_key = f"{policy['upload_dir']}/{file_name}"
    with file_path.open("rb") as f:
        files = {
            "OSSAccessKeyId": (None, policy["oss_access_key_id"]),
            "Signature": (None, policy["signature"]),
            "policy": (None, policy["policy"]),
            "x-oss-object-acl": (None, policy["x_oss_object_acl"]),
            "x-oss-forbid-overwrite": (None, policy["x_oss_forbid_overwrite"]),
            "key": (None, oss_key),
            "success_action_status": (None, "200"),
            "file": (file_name, f),
        }
        r = requests.post(policy["upload_host"], files=files, timeout=120)
        if r.status_code != 200:
            raise RuntimeError(f"OSS 上传失败 HTTP {r.status_code}: {r.text}")
    return f"oss://{oss_key}"


def create_voice(key: str, *, target_model: str, prefix: str, url: str) -> str:
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-DashScope-OssResourceResolve": "enable",
    }
    body = {
        "model": "voice-enrollment",
        "input": {
            "action": "create_voice",
            "target_model": target_model,
            "prefix": prefix,
            "url": url,
            "language_hints": ["zh"],
        },
    }
    data = http_json("POST", ENROLL_URL, headers, body)
    # 常见返回：output.voice_id
    out = data.get("output") or data.get("data") or data
    voice_id = out.get("voice_id") or out.get("voice")
    if not voice_id:
        raise RuntimeError(f"创建音色未返回 voice_id：{data}")
    return voice_id


def main() -> None:
    parser = argparse.ArgumentParser(description="用元元原声复刻 CosyVoice 音色")
    parser.add_argument("--audio", type=Path, default=DEFAULT_AUDIO, help="样本音频路径")
    parser.add_argument("--seconds", type=float, default=18.0, help="截取时长（秒）")
    parser.add_argument("--prefix", default="yuanyuan", help="音色前缀（字母数字，≤10）")
    parser.add_argument(
        "--target-model",
        default="cosyvoice-v3.5-plus",
        help="绑定合成模型（需支持 instruction；plus 通常更像）",
    )
    parser.add_argument("--no-write-settings", action="store_true")
    args = parser.parse_args()

    if not args.audio.exists():
        sys.exit(f"找不到音频：{args.audio}")

    s = load_settings()
    key = api_key(s)

    clip = ROOT / "out" / "enroll_clip.mp3"
    print(f"准备样本：{args.audio} → 前 {args.seconds}s …")
    prepare_clip(args.audio, clip, args.seconds)
    print(f"  clip = {clip} ({clip.stat().st_size} bytes)")

    print("上传到百炼临时存储 …")
    # 上传凭证的 model 需与后续 enrollment 一致
    policy = get_upload_policy(key, "voice-enrollment")
    oss_url = upload_to_oss(policy, clip)
    print(f"  url = {oss_url}")

    print(f"创建音色 target_model={args.target_model} prefix={args.prefix} …")
    voice_id = create_voice(
        key, target_model=args.target_model, prefix=args.prefix, url=oss_url
    )
    print(f"\n成功：voice_id = {voice_id}")

    if not args.no_write_settings:
        s["cosyvoiceVoice"] = voice_id
        s["cosyvoiceModel"] = args.target_model
        save_settings(s)
        print("已写入 settings.json：cosyvoiceVoice / cosyvoiceModel")
        print("请重启 server_cosyvoice.py 后，在设置里确认后端为 CosyVoice 再试通话。")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"失败：{e}", file=sys.stderr)
        sys.exit(1)
