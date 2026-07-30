#!/usr/bin/env python3
"""Create loudness, tempo, and composite variants of a validated reference."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from prepare_expressive_references import _normalize_loudness
from score_reference_tournament import _audio16


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--active", type=Path, default=WORK / "active-reference.json")
    parser.add_argument("--expressive-candidates", type=Path, default=WORK / "expressive-ref" / "candidates.jsonl")
    parser.add_argument("--expressive-report", type=Path, default=HERE / "reports" / "expressive-tournament-scores.json")
    parser.add_argument("--output-dir", type=Path, default=WORK / "reference-variants")
    args = parser.parse_args()
    active = json.loads(args.active.read_text(encoding="utf-8"))
    active_audio = Path(active["audio"])
    if active.get("validationPasses") is not True or hashlib.sha256(active_audio.read_bytes()).hexdigest() != active.get("audioSha256"):
        raise SystemExit("active reference is not validated")
    expressive = {row["id"]: row for row in (json.loads(line) for line in args.expressive_candidates.read_text(encoding="utf-8").splitlines() if line)}
    winner_id = json.loads(args.expressive_report.read_text(encoding="utf-8"))["winner"]["reference_id"]
    dynamic = expressive[winner_id]
    slow = min(expressive.values(), key=lambda row: float(row["char_rate"]))
    base = _audio16(active_audio)
    base_norm, _ = _normalize_loudness(base, 0.12)
    variants = [
        ("variant_loud", base_norm, active["text"], "loudness-only"),
        ("variant_slow88", librosa.effects.time_stretch(base_norm, rate=0.88), active["text"], "tempo-0.88"),
        ("variant_slow80", librosa.effects.time_stretch(base_norm, rate=0.80), active["text"], "tempo-0.80"),
    ]
    silence = np.zeros(int(0.24 * 16000), dtype=np.float32)
    for suffix, row in (("dynamic", dynamic), ("slow", slow)):
        other = _audio16(Path(row["audio"]))
        combined = np.concatenate((base_norm, silence, other))
        combined, _ = _normalize_loudness(combined, 0.12)
        variants.append((f"variant_composite_{suffix}", combined, active["text"].rstrip("。") + "。" + row["text"], f"composite-{row['original_id']}"))
    audio_dir = args.output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for item_id, audio, text, kind in variants:
        path = audio_dir / f"{item_id}.wav"
        sf.write(path, audio, 16000, subtype="PCM_16")
        rows.append({"id": item_id, "audio": str(path.resolve()), "text": text, "source_id": kind})
    output = args.output_dir / "candidates.jsonl"
    output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    print(json.dumps([{"id": row["id"], "source": row["source_id"]} for row in rows], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
