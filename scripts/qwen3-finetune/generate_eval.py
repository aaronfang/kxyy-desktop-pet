#!/usr/bin/env python3
"""Generate the fixed 12-item baseline or custom-voice evaluation set."""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
REF_AUDIO = (
    REPO
    / "scripts"
    / "persona-distill"
    / "sample_wav"
    / "kxyy-vocal-sample"
    / "kxyy-vocal-sample-12s.wav"
)
REF_TEXT = (
    "摘下来是会暗一点儿哈。带了一个那个有度数的隐形眼镜。"
    "不难受么不难受，不难受，我我我弄用这个他这个是那个额次抛的，"
    "就用一次就就丢掉的，所以不会难难受。"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--mode", choices=("baseline", "custom"), required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--speaker", default="yuanyuan")
    parser.add_argument("--seed", type=int, default=20260730)
    parser.add_argument("--max-new-tokens", type=int, default=240)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()

    prompts = json.loads((HERE / "eval_prompts.json").read_text(encoding="utf-8"))
    if len(prompts) != 12 or len(set(prompts)) != 12:
        raise SystemExit("evaluation corpus must contain exactly 12 unique prompts")
    if not 1 <= args.limit <= 12:
        raise SystemExit("limit must be in [1, 12]")
    prompts = prompts[: args.limit]
    output_dir = HERE / "reports" / "audio" / args.run_name
    metadata_path = HERE / "reports" / f"{args.run_name}.jsonl"
    if args.reset:
        if output_dir.exists():
            shutil.rmtree(output_dir)
        metadata_path.unlink(missing_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    model = Qwen3TTSModel.from_pretrained(
        str(args.model),
        dtype=torch.bfloat16,
        device_map="cuda:0",
        attn_implementation="sdpa",
    )
    rows = []
    for index, text in enumerate(prompts, start=1):
        torch.manual_seed(args.seed + index)
        torch.cuda.manual_seed_all(args.seed + index)
        started = time.perf_counter()
        if args.mode == "baseline":
            wavs, sample_rate = model.generate_voice_clone(
                text=text,
                language="Chinese",
                ref_audio=str(REF_AUDIO),
                ref_text=REF_TEXT,
                x_vector_only_mode=False,
                non_streaming_mode=True,
                max_new_tokens=args.max_new_tokens,
            )
        else:
            wavs, sample_rate = model.generate_custom_voice(
                text=text,
                language="Chinese",
                speaker=args.speaker,
                non_streaming_mode=True,
                max_new_tokens=args.max_new_tokens,
            )
        audio_path = output_dir / f"eval_{index:02d}.wav"
        sf.write(str(audio_path), wavs[0], sample_rate, subtype="PCM_16")
        row = {
            "id": f"eval_{index:02d}",
            "text": text,
            "audio": str(audio_path.resolve()),
            "duration_s": round(len(wavs[0]) / sample_rate, 3),
            "generation_s": round(time.perf_counter() - started, 3),
            "sample_rate": sample_rate,
            "mode": args.mode,
            "model": str(args.model.resolve()),
            "max_new_tokens": args.max_new_tokens,
            "hit_duration_guard": len(wavs[0]) / sample_rate >= args.max_new_tokens / 12 - 1.0,
        }
        rows.append(row)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(
            "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows),
            encoding="utf-8",
        )
        print(
            f"generated {index}/{args.limit} duration={row['duration_s']:.2f}s "
            f"wall={row['generation_s']:.2f}s",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
