#!/usr/bin/env python3
"""Fail-closed verifier for the local Qwen3-TTS fine-tuning dataset."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import soundfile as sf


HERE = Path(__file__).resolve().parent


def _validate(manifest: dict, manifest_path: Path) -> dict:
    errors: list[str] = []
    items = manifest.get("items") or []
    total = float(manifest.get("total_seconds", 0))
    if not 1800 <= total <= 3600:
        errors.append(f"total_seconds out of range: {total}")
    seen: set[str] = set()
    sources = {"train": set(), "validation": set()}
    dates = {"train": set(), "validation": set()}
    counts = {"train": 0, "validation": 0}
    for item in items:
        item_id = item.get("id", "")
        if item_id in seen:
            errors.append(f"duplicate id: {item_id}")
        seen.add(item_id)
        split = item.get("split")
        if split not in sources:
            errors.append(f"invalid split: {split}")
            continue
        sources[split].add(item.get("source_id"))
        dates[split].add(item.get("source_date"))
        counts[split] += 1
        if not item.get("has_text"):
            errors.append(f"missing transcript: {item_id}")
        audio_path = HERE / item.get("audio", "")
        if not audio_path.is_file():
            errors.append(f"missing audio: {item_id}")
            continue
        info = sf.info(str(audio_path))
        if info.samplerate != 24000 or info.channels != 1:
            errors.append(f"invalid format: {item_id}")
        if not 3.0 <= info.duration <= 12.0:
            errors.append(f"invalid duration: {item_id}={info.duration:.3f}")
    overlap = sources["train"] & sources["validation"]
    if overlap:
        errors.append(f"source leakage: {sorted(overlap)}")
    date_overlap = dates["train"] & dates["validation"]
    if date_overlap:
        errors.append(f"source date leakage: {sorted(date_overlap)}")
    train_raw = manifest_path.parent / "train_raw.jsonl"
    raw_lines = [line for line in train_raw.read_text(encoding="utf-8").splitlines() if line] if train_raw.is_file() else []
    if len(raw_lines) != counts["train"]:
        errors.append(f"train JSONL count mismatch: {len(raw_lines)} != {counts['train']}")
    result = {
        "ok": not errors,
        "items": len(items),
        "total_seconds": total,
        "train_sources": len(sources["train"]),
        "validation_sources": len(sources["validation"]),
        "errors": errors[:20],
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--self-test-date-leak", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    result = _validate(manifest, args.manifest)
    if args.self_test_date_leak:
        if not result["ok"]:
            raise SystemExit("baseline manifest must pass before reverse test")
        mutated = copy.deepcopy(manifest)
        train_date = next(
            item["source_date"] for item in mutated["items"] if item["split"] == "train"
        )
        validation_item = next(
            item for item in mutated["items"] if item["split"] == "validation"
        )
        validation_item["source_date"] = train_date
        reverse = _validate(mutated, args.manifest)
        detected = any(error.startswith("source date leakage:") for error in reverse["errors"])
        print(json.dumps({"ok": detected, "date_leak_detected": detected}, ensure_ascii=False))
        return 0 if detected else 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
