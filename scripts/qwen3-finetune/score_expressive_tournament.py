#!/usr/bin/env python3
"""Rank clone references for slower pacing, loudness, and within-sentence dynamics."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np

from score_reference_tournament import CONTROL_ID, _audio16, _normalize


HERE = Path(__file__).resolve().parent


def _style(path: Path, text: str) -> dict[str, float]:
    audio = _audio16(path)
    frames = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    noise = float(np.percentile(frames, 10)) if frames.size else 0.0
    threshold = max(0.008, noise * 2.5)
    indices = np.flatnonzero(frames >= threshold)
    if not indices.size:
        raise ValueError("no active speech")
    first, last = int(indices[0]), int(indices[-1])
    inner = frames[first : last + 1]
    active = inner[inner >= threshold]
    start = first * 256
    end = min(len(audio), last * 256 + 1024)
    trimmed = audio[start:end]
    duration = len(trimmed) / 16000
    f0 = librosa.yin(trimmed, fmin=80, fmax=500, sr=16000, frame_length=2048, hop_length=256)
    plausible = f0[(f0 >= 100) & (f0 <= 450)]
    return {
        "trimmed_duration_s": round(duration, 6),
        "char_rate": round(len(_normalize(text)) / max(duration, 0.001), 6),
        "pause_ratio": round(1.0 - len(active) / max(1, len(inner)), 6),
        "active_rms": round(float(np.median(active)), 7),
        "energy_range_db": round(float(20 * np.log10((np.percentile(active, 90) + 1e-6) / (np.percentile(active, 25) + 1e-6))), 6),
        "f0_iqr": round(float(np.percentile(plausible, 75) - np.percentile(plausible, 25)), 6) if plausible.size else 0.0,
    }


def _gate(item: dict, control: dict, expected_count: int = 3) -> tuple[bool, list[str]]:
    reasons = []
    if item["valid_count"] != expected_count:
        reasons.append("incomplete")
    similarity_floor = -0.01 if expected_count >= 12 else -0.02
    if item["similarity_mean"] - control["similarity_mean"] < similarity_floor:
        reasons.append("speaker_regression")
    if expected_count >= 12 and item.get("similarity_improved_count", 0) < 8:
        reasons.append("speaker_pair_regression")
    if item["cer_mean"] - control["cer_mean"] > 0.02:
        reasons.append("cer_regression")
    if item["active_rms_mean"] < 0.07:
        reasons.append("too_quiet")
    if item["char_rate_mean"] > control["char_rate_mean"] * 0.95:
        reasons.append("not_slower")
    if (
        item["f0_iqr_mean"] < control["f0_iqr_mean"] * 1.30
        or item["energy_range_db_mean"] < control["energy_range_db_mean"] - 1.5
    ):
        reasons.append("not_more_dynamic")
    return not reasons, reasons


def _self_test() -> None:
    control = {"similarity_mean": 0.66, "cer_mean": 0.08, "char_rate_mean": 5.8, "energy_range_db_mean": 7.0, "f0_iqr_mean": 35.0}
    good = {"valid_count": 3, "similarity_mean": 0.65, "cer_mean": 0.08, "active_rms_mean": 0.11, "char_rate_mean": 5.2, "energy_range_db_mean": 6.0, "f0_iqr_mean": 55.0}
    assert _gate(good, control)[0]
    for change, reason in (({"active_rms_mean": 0.04}, "too_quiet"), ({"char_rate_mean": 5.7}, "not_slower"), ({"f0_iqr_mean": 40.0}, "not_more_dynamic"), ({"energy_range_db_mean": 5.0}, "not_more_dynamic"), ({"similarity_mean": 0.60}, "speaker_regression")):
        passed, reasons = _gate({**good, **change}, control)
        assert not passed and reason in reasons
    print("self-test passed: quiet/fast/flat/off-speaker candidates rejected")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True, help="scored JSONL produced by score_reference_tournament.py")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-count", type=int, default=3)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return 0
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    grouped = defaultdict(list)
    for row in rows:
        if row.get("score_status") == "ok":
            row["expressive_style"] = _style(Path(row["audio"]), row["text"])
        grouped[row["reference_id"]].append(row)
    aggregates = []
    for reference_id, items in grouped.items():
        valid = [item for item in items if item.get("score_status") == "ok"]
        mean = lambda key: sum(float(item[key]) for item in valid) / len(valid) if valid else 0.0
        style_mean = lambda key: sum(float(item["expressive_style"][key]) for item in valid) / len(valid) if valid else 0.0
        aggregates.append({
            "reference_id": reference_id,
            "valid_count": len(valid),
            "similarity_mean": round(mean("centroid_similarity"), 6),
            "cer_mean": round(mean("cer"), 6),
            "active_rms_mean": round(style_mean("active_rms"), 6),
            "char_rate_mean": round(style_mean("char_rate"), 6),
            "pause_ratio_mean": round(style_mean("pause_ratio"), 6),
            "energy_range_db_mean": round(style_mean("energy_range_db"), 6),
            "f0_iqr_mean": round(style_mean("f0_iqr"), 6),
        })
    control = next(item for item in aggregates if item["reference_id"] == CONTROL_ID)
    control_rows = {int(row["probe_index"]): row for row in grouped[CONTROL_ID] if row.get("score_status") == "ok"}
    for item in aggregates:
        if item["reference_id"] == CONTROL_ID:
            item.update(passes=False, rejection_reasons=["control"], expressive_gain=0.0)
            continue
        candidate_rows = {int(row["probe_index"]): row for row in grouped[item["reference_id"]] if row.get("score_status") == "ok"}
        item["similarity_improved_count"] = sum(
            candidate_rows[index]["centroid_similarity"] > base["centroid_similarity"]
            for index, base in control_rows.items()
            if index in candidate_rows
        )
        passed, reasons = _gate(item, control, args.expected_count)
        gain = (
            (control["char_rate_mean"] - item["char_rate_mean"]) / max(control["char_rate_mean"], 1.0)
            + (item["energy_range_db_mean"] - control["energy_range_db_mean"]) / 10.0
            + (item["f0_iqr_mean"] - control["f0_iqr_mean"]) / max(control["f0_iqr_mean"], 20.0) * 0.25
            + min(item["active_rms_mean"] / 0.12, 1.0) * 0.25
        )
        item.update(passes=passed, rejection_reasons=reasons, expressive_gain=round(gain, 6))
    passing = [item for item in aggregates if item["passes"]]
    passing.sort(key=lambda item: (-item["expressive_gain"], -item["similarity_mean"], item["reference_id"]))
    report = {"control": control, "winner": passing[0] if passing else None, "passing_count": len(passing), "ranking": sorted(aggregates, key=lambda item: (not item["passes"], -item["expressive_gain"]))}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"control": control, "winner": report["winner"], "passing_count": len(passing)}, ensure_ascii=False))
    return 0 if passing else 2


if __name__ == "__main__":
    raise SystemExit(main())
