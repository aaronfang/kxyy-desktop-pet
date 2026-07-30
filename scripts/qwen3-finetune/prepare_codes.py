#!/usr/bin/env python3
"""Checkpointed wrapper around Qwen3-TTS's official codec preparation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from qwen_tts import Qwen3TTSTokenizer


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_checkpoint(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument(
        "--tokenizer-model", default="Qwen/Qwen3-TTS-Tokenizer-12Hz"
    )
    parser.add_argument("--input", type=Path, default=WORK / "train_raw.jsonl")
    parser.add_argument("--output", type=Path, default=WORK / "train_with_codes.jsonl")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 8:
        raise SystemExit("batch-size must be in [1, 8] for the 16GB training host")

    checkpoint_path = args.output.with_suffix(".checkpoint.json")
    if args.reset:
        args.output.unlink(missing_ok=True)
        checkpoint_path.unlink(missing_ok=True)
    rows = [
        json.loads(line)
        for line in args.input.read_text(encoding="utf-8").splitlines()
        if line
    ]
    signature = {
        "input_sha256": _sha256(args.input),
        "tokenizer_model": args.tokenizer_model,
    }
    completed = 0
    if checkpoint_path.is_file():
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("signature") != signature:
            raise SystemExit("codec checkpoint differs; pass --reset")
        encoded = [
            json.loads(line)
            for line in args.output.read_text(encoding="utf-8").splitlines()
            if line
        ]
        completed = int(checkpoint.get("completed_count", -1))
        if len(encoded) < completed:
            raise SystemExit("codec checkpoint/output count mismatch; pass --reset")
        if len(encoded) > completed:
            args.output.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in encoded[:completed]),
                encoding="utf-8",
            )
        print(f"resume encoded={completed}/{len(rows)}", flush=True)
    elif args.output.exists():
        raise SystemExit("codec output exists without checkpoint; pass --reset")

    tokenizer = Qwen3TTSTokenizer.from_pretrained(
        args.tokenizer_model, device_map=args.device
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("a", encoding="utf-8") as handle:
        for offset in range(completed, len(rows), args.batch_size):
            batch = rows[offset : offset + args.batch_size]
            result = tokenizer.encode([row["audio"] for row in batch])
            for codes, row in zip(result.audio_codes, batch):
                encoded_row = dict(row)
                encoded_row["audio_codes"] = codes.cpu().tolist()
                handle.write(json.dumps(encoded_row, ensure_ascii=False) + "\n")
            handle.flush()
            completed += len(batch)
            _write_checkpoint(
                checkpoint_path,
                {"signature": signature, "completed_count": completed},
            )
            print(f"encoded {completed}/{len(rows)}", flush=True)
    return 0 if completed == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
