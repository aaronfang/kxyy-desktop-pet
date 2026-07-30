#!/usr/bin/env python3
"""Build a source-disjoint 30–60 minute Qwen3-TTS dataset."""

from __future__ import annotations

import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path

import librosa
import soundfile as sf


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORK = HERE / "work"
DEFAULT_REF = (
    REPO
    / "scripts"
    / "persona-distill"
    / "sample_wav"
    / "kxyy-vocal-sample"
    / "kxyy-vocal-sample-12s.wav"
)


def _round_robin(groups: dict[str, list[dict]]):
    queues = {key: list(value) for key, value in groups.items()}
    while queues:
        for key in list(sorted(queues)):
            if queues[key]:
                yield queues[key].pop(0)
            if not queues[key]:
                del queues[key]


def _take(rows: list[dict], target: float) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row["source_id"]].append(row)
    for values in groups.values():
        values.sort(key=lambda item: (-item["speaker_similarity"], item["id"]))
    chosen = []
    seconds = 0.0
    for row in _round_robin(groups):
        if seconds + row["duration_s"] > target and seconds >= target * 0.95:
            break
        chosen.append(row)
        seconds += row["duration_s"]
        if seconds >= target:
            break
    return chosen


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=WORK / "scored.jsonl")
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--train-seconds", type=int, default=2700)
    parser.add_argument("--validation-seconds", type=int, default=600)
    args = parser.parse_args()

    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    eligible = [row for row in rows if row.get("speaker_similarity", -1) >= args.threshold]
    source_ids = sorted({row["source_id"] for row in eligible})
    if len(source_ids) < 5:
        raise SystemExit("fewer than five eligible source recordings")
    validation_sources = set(source_ids[-max(1, len(source_ids) // 5) :])
    train_rows = [row for row in eligible if row["source_id"] not in validation_sources]
    validation_rows = [row for row in eligible if row["source_id"] in validation_sources]
    train = _take(train_rows, args.train_seconds)
    validation = _take(validation_rows, args.validation_seconds)
    selected = {row["id"] for row in train + validation}

    dataset_root = WORK / "dataset"
    if dataset_root.exists():
        shutil.rmtree(dataset_root)
    (dataset_root / "train").mkdir(parents=True)
    (dataset_root / "validation").mkdir(parents=True)

    ref_audio, ref_sr = sf.read(str(DEFAULT_REF), always_2d=False)
    if ref_audio.ndim > 1:
        ref_audio = ref_audio.mean(axis=1)
    if ref_sr != 24000:
        ref_audio = librosa.resample(ref_audio, orig_sr=ref_sr, target_sr=24000)
    ref_path = dataset_root / "ref.wav"
    sf.write(str(ref_path), ref_audio, 24000, subtype="PCM_16")

    manifest_items = []
    raw_lines = []
    for split, split_rows in (("train", train), ("validation", validation)):
        for row in split_rows:
            destination = dataset_root / split / f"{row['id']}.wav"
            shutil.copyfile(row["audio"], destination)
            manifest_items.append(
                {
                    "id": row["id"],
                    "audio": str(destination.relative_to(HERE)).replace("\\", "/"),
                    "source_id": row["source_id"],
                    "source_date": row["source_date"],
                    "split": split,
                    "duration_s": row["duration_s"],
                    "speaker_similarity": row["speaker_similarity"],
                    "has_text": bool(row["text"]),
                    "sample_rate": 24000,
                    "channels": 1,
                }
            )
            if split == "train":
                raw_lines.append(
                    {
                        "audio": str(destination.resolve()),
                        "text": row["text"],
                        "ref_audio": str(ref_path.resolve()),
                        "language": "Chinese",
                    }
                )

    train_raw = WORK / "train_raw.jsonl"
    train_raw.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in raw_lines),
        encoding="utf-8",
    )
    split_seconds = {
        "train": round(sum(row["duration_s"] for row in train), 3),
        "validation": round(sum(row["duration_s"] for row in validation), 3),
    }
    manifest = {
        "schema_version": 1,
        "threshold": args.threshold,
        "eligible_count": len(eligible),
        "selected_count": len(selected),
        "total_seconds": round(sum(split_seconds.values()), 3),
        "split_seconds": split_seconds,
        "rejected_counts": {
            "speaker_similarity": len(rows) - len(eligible),
            "capacity": len(eligible) - len(selected),
        },
        "items": manifest_items,
    }
    (WORK / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({key: manifest[key] for key in ("selected_count", "total_seconds", "split_seconds")}, ensure_ascii=False))
    return 0 if 1800 <= manifest["total_seconds"] <= 3600 else 2


if __name__ == "__main__":
    raise SystemExit(main())
