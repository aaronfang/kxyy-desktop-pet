#!/usr/bin/env python3
"""用本机 mlx-audio + Qwen3-TTS 零样本复刻，对照火山样例。

依赖（在 scripts/voice-ab/.venv 里）：
  pip install mlx-audio soundfile numpy

用法：
  先跑 synth_volc.py，再：
  .venv/bin/python synth_local.py
  .venv/bin/python synth_local.py --model mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PHRASES = ROOT / "phrases.json"
VOLC_OUT = ROOT / "out" / "volc"
LOCAL_OUT = ROOT / "out" / "local"
PROMPT_MP3 = VOLC_OUT / "prompt.mp3"
PROMPT_WAV = ROOT / "out" / "prompt_ref.wav"

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"


def ensure_prompt_wav() -> tuple[Path, str]:
    phrases = json.loads(PHRASES.read_text(encoding="utf-8"))
    prompt_text = phrases["prompt"]["text"]
    if not PROMPT_MP3.exists():
        raise SystemExit(f"缺少火山参考音 {PROMPT_MP3}，请先运行 synth_volc.py")
    PROMPT_WAV.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(PROMPT_MP3),
                "-ac",
                "1",
                "-ar",
                "24000",
                str(PROMPT_WAV),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as e:
        raise SystemExit("ffmpeg 转码超时（120s）") from e
    return PROMPT_WAV, prompt_text


def save_audio(audio, path: Path, sample_rate: int) -> None:
    import numpy as np
    import soundfile as sf

    arr = np.array(audio)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), arr, sample_rate)


def main() -> None:
    parser = argparse.ArgumentParser(description="本地 Qwen3-TTS 复刻听测")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--ref",
        type=Path,
        default=None,
        help="自定义参考 wav（默认用火山 prompt 样例）",
    )
    parser.add_argument(
        "--ref-text",
        default=None,
        help="参考音对应文案（自定义 --ref 时必填）",
    )
    args = parser.parse_args()

    if args.ref:
        if not args.ref_text:
            raise SystemExit("使用 --ref 时必须同时提供 --ref-text")
        ref_wav, ref_text = args.ref, args.ref_text
    else:
        ref_wav, ref_text = ensure_prompt_wav()

    print(f"加载模型 {args.model} …")
    from mlx_audio.tts.utils import load_model

    model = load_model(args.model)
    phrases = json.loads(PHRASES.read_text(encoding="utf-8"))
    LOCAL_OUT.mkdir(parents=True, exist_ok=True)
    meta: list[dict] = []

    # 只合成 items（prompt 本身是参考音，不再本地复刻自己）
    for job in phrases["items"]:
        jid = job["id"]
        text = job["text"]
        out = LOCAL_OUT / f"{jid}.wav"
        print(f"  [local] {jid} …", end="", flush=True)
        t0 = time.perf_counter()
        try:
            results = list(
                model.generate(
                    text=text,
                    ref_audio=str(ref_wav),
                    ref_text=ref_text,
                )
            )
            if not results:
                raise RuntimeError("模型未返回音频")
            audio = results[0].audio
            sr = getattr(results[0], "sample_rate", None) or getattr(
                model, "sample_rate", 24000
            )
            save_audio(audio, out, int(sr))
            sec = time.perf_counter() - t0
            print(f" ok {sec:.2f}s")
            meta.append(
                {
                    "id": jid,
                    "provider": "local",
                    "model": args.model,
                    "path": str(out.relative_to(ROOT)),
                    "text": text,
                    "emotion": job.get("emotion", ""),
                    "latency_s": round(sec, 3),
                }
            )
        except Exception as e:  # noqa: BLE001
            print(f" FAIL: {e}")
            meta.append({"id": jid, "provider": "local", "error": str(e)})

    (LOCAL_OUT / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"完成 → {LOCAL_OUT}")
    print("打开 listen.html 做左右听测。")


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print(
            "缺少依赖。请先：\n"
            "  cd scripts/voice-ab && python3.12 -m venv .venv\n"
            "  .venv/bin/pip install -U pip mlx-audio soundfile numpy",
            file=sys.stderr,
        )
        sys.exit(1)
