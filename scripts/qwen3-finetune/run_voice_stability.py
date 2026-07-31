#!/usr/bin/env python3
"""Generate repeated production-path probes for voice-identity stability."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from faster_qwen3_tts import FasterQwen3TTS


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
SAMPLE_RATE = 24000
CHUNK_STEPS = 24


def _load_reference(path: Path) -> dict:
    item = json.loads(path.read_text(encoding="utf-8"))
    audio = Path(item.get("audio") or "").resolve()
    text = str(item.get("text") or "").strip()
    expected_hash = str(item.get("audioSha256") or "").lower()
    audio.relative_to(WORK.resolve())
    if (
        item.get("schemaVersion") != 1
        or item.get("validationPasses") is not True
        or not audio.is_file()
        or not 8 <= len(text) <= 200
        or len(expected_hash) != 64
        or hashlib.sha256(audio.read_bytes()).hexdigest() != expected_hash
    ):
        raise SystemExit("reference manifest is not validated")
    return {"audio": str(audio), "text": text}


def _drain(generator) -> tuple[np.ndarray, int, float]:
    started = time.perf_counter()
    chunks = []
    sample_rate = 0
    try:
        for result in generator:
            if not isinstance(result, tuple) or len(result) < 2:
                raise RuntimeError("unexpected provider result")
            audio = np.asarray(result[0], dtype=np.float32).reshape(-1)
            sample_rate = int(result[1])
            if sample_rate != SAMPLE_RATE or audio.size == 0:
                raise RuntimeError("invalid provider audio")
            chunks.append(audio)
    finally:
        close = getattr(generator, "close", None)
        if callable(close):
            close()
    if not chunks:
        raise RuntimeError("provider returned no audio")
    return np.concatenate(chunks), sample_rate, time.perf_counter() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--mode", choices=("clone", "custom"), required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--reference-manifest", type=Path)
    parser.add_argument("--speaker", default="yuanyuan")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--limit", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260731)
    parser.add_argument("--max-new-tokens", type=int, default=240)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    if not args.model.is_dir():
        raise SystemExit("model must be a local directory")
    if args.mode == "clone" and args.reference_manifest is None:
        raise SystemExit("clone mode requires --reference-manifest")
    if not 2 <= args.repeats <= 20 or not 1 <= args.limit <= 12:
        raise SystemExit("repeats must be in [2, 20] and limit in [1, 12]")

    prompts = json.loads((HERE / "eval_prompts.json").read_text(encoding="utf-8"))
    if len(prompts) != 12 or len(set(prompts)) != 12:
        raise SystemExit("evaluation corpus must contain exactly 12 unique prompts")
    prompts = prompts[: args.limit]
    reference = _load_reference(args.reference_manifest) if args.reference_manifest else None

    output_dir = HERE / "reports" / "audio" / args.run_name
    metadata_path = HERE / "reports" / f"{args.run_name}.jsonl"
    if args.reset:
        if output_dir.exists():
            shutil.rmtree(output_dir)
        metadata_path.unlink(missing_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    model = FasterQwen3TTS.from_pretrained(
        str(args.model.resolve()),
        device="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
        backend="torch",
    )

    def create_stream(text: str, max_new_tokens: int):
        common = {
            "text": text,
            "language": "Chinese",
            "non_streaming_mode": True,
            "max_new_tokens": max_new_tokens,
            "chunk_size": CHUNK_STEPS,
        }
        if args.mode == "clone":
            return model.generate_voice_clone_streaming(
                ref_audio=reference["audio"],
                ref_text=reference["text"],
                parity_mode=False,
                **common,
            )
        return model.generate_custom_voice_streaming(speaker=args.speaker, **common)

    _drain(create_stream("你好", 32))
    rows = []
    total = len(prompts) * args.repeats
    for prompt_index, text in enumerate(prompts, start=1):
        for repeat in range(1, args.repeats + 1):
            seed = args.seed + prompt_index * 100 + repeat
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            item_id = f"eval_{prompt_index:02d}-r{repeat:02d}"
            audio_path = output_dir / f"{item_id}.wav"
            row = {
                "id": item_id,
                "prompt_id": f"eval_{prompt_index:02d}",
                "repeat": repeat,
                "text": text,
                "audio": str(audio_path.resolve()),
                "mode": args.mode,
                "model": str(args.model.resolve()),
                "seed": seed,
            }
            try:
                audio, sample_rate, wall = _drain(
                    create_stream(text, args.max_new_tokens)
                )
                sf.write(str(audio_path), audio, sample_rate, subtype="PCM_16")
                duration = len(audio) / sample_rate
                row.update(
                    status="ok",
                    sample_rate=sample_rate,
                    duration_s=round(duration, 3),
                    generation_s=round(wall, 3),
                    hit_duration_guard=(
                        duration >= args.max_new_tokens / 12 - 1.0
                    ),
                )
            except Exception as error:
                row.update(status="failed", error_type=type(error).__name__)
            rows.append(row)
            metadata_path.write_text(
                "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows),
                encoding="utf-8",
            )
            print(
                f"generated {len(rows)}/{total} id={item_id} status={row['status']}",
                flush=True,
            )
    return 0 if len(rows) == total and all(row["status"] == "ok" for row in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
