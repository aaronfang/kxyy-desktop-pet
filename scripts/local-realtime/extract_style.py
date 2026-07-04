#!/usr/bin/env python3
"""从人物原声提取说话节奏，写入 out/voice_style.json，供 CosyVoice TTS 使用。"""

from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
DEFAULT_AUDIO = REPO / "merged.mp3"
OUT = ROOT / "out" / "voice_style.json"


def extract(audio: Path) -> dict:
    import mlx_whisper

    wav = ROOT / "out" / "style_src.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(audio), "-ac", "1", "-ar", "16000", str(wav)],
        check=True,
        capture_output=True,
    )

    with wave.open(str(wav), "rb") as w:
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())
    samples = memoryview(pcm).cast("h")
    frame = int(rate * 0.02)
    energies = []
    for i in range(0, len(samples) - frame, frame):
        s = 0.0
        for j in range(frame):
            v = samples[i + j] / 32768.0
            s += v * v
        energies.append((s / frame) ** 0.5)

    thr = max(sorted(energies)[int(len(energies) * 0.5)] * 0.35, 0.01)
    speech = [e >= thr for e in energies]
    speech_ratio = sum(speech) / max(1, len(speech))

    pauses = []
    run = 0
    for on in speech:
        if not on:
            run += 1
        elif run:
            pauses.append(run * 0.02)
            run = 0
    mid_pauses = [p for p in pauses if 0.15 <= p <= 1.5]
    avg_pause = sum(mid_pauses) / len(mid_pauses) if mid_pauses else 0.3

    result = mlx_whisper.transcribe(
        str(wav),
        path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
        language="zh",
        verbose=False,
    )
    char_rates = []
    for seg in result.get("segments") or []:
        text = (seg.get("text") or "").strip()
        chars = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
        dur = float(seg.get("end", 0)) - float(seg.get("start", 0))
        if chars >= 2 and dur >= 0.3:
            char_rates.append(chars / dur)
    avg_cps = sum(char_rates) / len(char_rates) if char_rates else 4.0

    # CosyVoice 默认约偏播音腔；按实测语速映射 rate
    ref_cps = 4.8
    suggested_rate = max(0.78, min(1.05, avg_cps / ref_cps))

    # 停顿多 → 轻提示「句间留空」，不提口吃/时快时慢（易人机感）
    pause_hint = speech_ratio < 0.62 or avg_pause >= 0.35

    style = {
        "source": str(audio.resolve()),
        "duration_s": round(len(samples) / rate, 2),
        "speech_ratio": round(speech_ratio, 3),
        "avg_pause_s": round(avg_pause, 3),
        "pause_count": len(mid_pauses),
        "chars_per_sec": round(avg_cps, 3),
        "suggested_rate": round(suggested_rate, 3),
        "pause_hint": pause_hint,
        "transcript_preview": (result.get("text") or "")[:100],
    }
    OUT.write_text(json.dumps(style, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return style


if __name__ == "__main__":
    import sys

    audio = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_AUDIO
    if not audio.exists():
        raise SystemExit(f"找不到音频：{audio}")
    style = extract(audio)
    print(json.dumps(style, ensure_ascii=False, indent=2))
    print(f"\n已写入 {OUT}")
