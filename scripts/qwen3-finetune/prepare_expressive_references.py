#!/usr/bin/env python3
"""Automatically choose slower, more dynamic references and normalize loudness."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from score_reference_tournament import _audio16, _normalize


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def _energy_range_db(audio: np.ndarray) -> float:
    frames = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    floor = max(0.006, float(np.percentile(frames, 10)) * 2.0) if frames.size else 0.006
    active = frames[frames >= floor]
    if not active.size:
        return 0.0
    return float(20 * np.log10((np.percentile(active, 90) + 1e-6) / (np.percentile(active, 25) + 1e-6)))


def _normalize_loudness(audio: np.ndarray, target_active_rms: float) -> tuple[np.ndarray, float]:
    frames = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    floor = max(0.006, float(np.percentile(frames, 10)) * 2.0) if frames.size else 0.006
    active = frames[frames >= floor]
    current = float(np.median(active)) if active.size else float(np.sqrt(np.mean(audio * audio)))
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    gain = min(target_active_rms / max(current, 1e-6), 0.92 / max(peak, 1e-6))
    return np.clip(audio * gain, -0.95, 0.95).astype(np.float32), float(gain)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=WORK / "ref-selection" / "candidates.jsonl")
    parser.add_argument("--output-dir", type=Path, default=WORK / "expressive-ref")
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--target-active-rms", type=float, default=0.12)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    enriched = []
    for row in rows:
        audio = _audio16(Path(row["audio"]))
        rate = len(_normalize(row["text"])) / max(float(row["duration_s"]), 0.001)
        energy = _energy_range_db(audio)
        # Preserve speaker identity first, then reward deliberately slower delivery,
        # pitch range, energy contrast, and reliable transcripts.
        if float(row["centroid_similarity"]) < 0.85 or rate > 5.25:
            continue
        score = (
            0.35 * np.clip((float(row["centroid_similarity"]) - 0.85) / 0.06, 0, 1)
            + 0.25 * np.clip((5.25 - rate) / 2.0, 0, 1)
            + 0.15 * np.clip((float(row["f0_iqr"]) - 35) / 50, 0, 1)
            + 0.15 * np.clip((energy - 4) / 7, 0, 1)
            + 0.10 * np.clip((float(row["asr_avg_logprob"]) + 0.65) / 0.45, 0, 1)
        )
        enriched.append({**row, "char_rate": round(rate, 6), "energy_range_db": round(energy, 3), "expressive_score": round(float(score), 6)})
    enriched.sort(key=lambda row: (-row["expressive_score"], row["id"]))
    selected = []
    sources = set()
    for row in enriched:
        if row["source_id"] in sources:
            continue
        selected.append(row)
        sources.add(row["source_id"])
        if len(selected) == args.count:
            break
    if len(selected) != args.count:
        raise SystemExit(f"only {len(selected)} expressive references available")
    audio_dir = args.output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    output = []
    for row in selected:
        audio = _audio16(Path(row["audio"]))
        normalized, gain = _normalize_loudness(audio, args.target_active_rms)
        path = audio_dir / f"{row['id']}.wav"
        sf.write(path, normalized, 16000, subtype="PCM_16")
        output.append({**row, "id": f"expressive_{row['id']}", "original_id": row["id"], "audio": str(path.resolve()), "normalization_gain": round(gain, 6)})
    output_path = args.output_dir / "candidates.jsonl"
    output_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in output), encoding="utf-8")
    print(json.dumps([{"id": row["id"], "rate": row["char_rate"], "f0_iqr": row["f0_iqr"], "energy_db": row["energy_range_db"], "gain": row["normalization_gain"]} for row in output], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
