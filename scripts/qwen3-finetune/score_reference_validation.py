#!/usr/bin/env python3
"""Gate the winning reference on speaker, intelligibility, robustness, and style."""

from __future__ import annotations

import argparse
import json
import math
import warnings
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np
from faster_whisper import WhisperModel

from score_reference_tournament import (
    CONTROL_ID,
    _acoustics,
    _audio16,
    _edit_distance,
    _embedding,
    _is_repetitive,
    _normalize,
    _transcribe,
)


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def _style(audio: np.ndarray, text: str, duration_s: float) -> dict[str, float]:
    frames = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    floor = float(np.percentile(frames, 10)) if frames.size else 0.0
    active = frames >= max(0.006, floor * 2.0)
    active_rms = float(np.median(frames[active])) if active.any() else 0.0
    try:
        f0 = librosa.yin(audio, fmin=80, fmax=500, sr=16000, frame_length=2048, hop_length=256)
        plausible = f0[(f0 >= 100) & (f0 <= 450)]
    except Exception:
        plausible = np.asarray([], dtype=np.float32)
    return {
        "f0_median": round(float(np.median(plausible)), 3) if plausible.size else 0.0,
        "f0_iqr": round(float(np.percentile(plausible, 75) - np.percentile(plausible, 25)), 3) if plausible.size else 0.0,
        "pause_ratio": round(1.0 - float(active.mean()), 6) if active.size else 1.0,
        "active_rms": round(active_rms, 7),
        "char_rate": round(len(_normalize(text)) / max(duration_s, 0.001), 6),
    }


def _target(candidates: list[dict]) -> dict[str, float]:
    def median(key: str) -> float:
        return float(np.median([float(row[key]) for row in candidates]))
    return {
        "f0_median": median("f0_median"),
        "f0_iqr": median("f0_iqr"),
        "pause_ratio": 1.0 - median("speech_ratio"),
        "active_rms": median("active_rms"),
        "char_rate": float(np.median([len(_normalize(row["text"])) / max(float(row["duration_s"]), 0.001) for row in candidates])),
    }


def _style_distance(style: dict, target: dict) -> float:
    terms = [
        abs(math.log(max(style["f0_median"], 1.0) / max(target["f0_median"], 1.0))) / 0.25,
        abs(style["f0_iqr"] - target["f0_iqr"]) / max(target["f0_iqr"], 20.0),
        abs(style["pause_ratio"] - target["pause_ratio"]) / 0.25,
        abs(math.log(max(style["active_rms"], 1e-4) / max(target["active_rms"], 1e-4))) / 0.75,
        abs(style["char_rate"] - target["char_rate"]) / max(target["char_rate"], 1.0),
    ]
    return round(float(np.mean(np.clip(terms, 0, 4))), 6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=HERE / "reports" / "reference-validation.jsonl")
    parser.add_argument("--candidates", type=Path, default=WORK / "ref-selection" / "candidates.jsonl")
    parser.add_argument("--centroid", type=Path, default=WORK / "ref-selection" / "speaker-centroid.npy")
    parser.add_argument("--output", type=Path, default=HERE / "reports" / "reference-validation-scores.json")
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    candidates = [json.loads(line) for line in args.candidates.read_text(encoding="utf-8").splitlines() if line]
    target = _target(candidates)
    centroid = np.asarray(np.load(args.centroid), dtype=np.float32).reshape(-1)
    centroid /= np.linalg.norm(centroid) + 1e-8
    from funasr import AutoModel
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        speaker_model = AutoModel(model="cam++", device="cuda", disable_update=True)
    asr_model = WhisperModel("small", device="cuda", compute_type="float16")
    scored = []
    for source in rows:
        item = dict(source)
        try:
            audio = _audio16(Path(source["audio"]))
            asr = _transcribe(asr_model, Path(source["audio"])) if audio.size else ""
            expected, actual = _normalize(source["text"]), _normalize(asr)
            style = _style(audio, source["text"], float(source.get("duration_s", 0.0)))
            item.update(
                score_status="ok" if audio.size else "failed",
                centroid_similarity=round(float(np.dot(_embedding(speaker_model, audio), centroid)), 6) if audio.size else 0.0,
                cer=round(_edit_distance(expected, actual) / max(1, len(expected)), 6),
                asr=asr,
                repetitive_asr=_is_repetitive(asr),
                style=style,
                style_distance=_style_distance(style, target),
                **_acoustics(audio),
            )
        except Exception as error:
            item.update(score_status="failed", score_error_type=type(error).__name__)
        scored.append(item)
        print(f"scored {len(scored)}/{len(rows)}", flush=True)
    grouped = defaultdict(list)
    for row in scored:
        grouped[row["reference_id"]].append(row)
    if CONTROL_ID not in grouped or len(grouped) != 2:
        raise SystemExit("validation requires one control and one candidate")
    summaries = {}
    for reference_id, items in grouped.items():
        valid = [item for item in items if item.get("score_status") == "ok"]
        mean = lambda key: sum(float(item[key]) for item in valid) / len(valid) if valid else 0.0
        summaries[reference_id] = {
            "reference_id": reference_id,
            "count": len(items),
            "valid_count": len(valid),
            "similarity_mean": round(mean("centroid_similarity"), 6),
            "cer_mean": round(mean("cer"), 6),
            "style_distance_mean": round(mean("style_distance"), 6),
            "duration_guard_count": sum(bool(item.get("hit_duration_guard")) for item in items),
            "repetition_count": sum(bool(item.get("repetitive_asr")) for item in items),
        }
    control = summaries[CONTROL_ID]
    candidate_id = next(key for key in summaries if key != CONTROL_ID)
    candidate = summaries[candidate_id]
    paired = []
    for item_id in sorted({row["id"] for row in rows}):
        base = next(row for row in scored if row["reference_id"] == CONTROL_ID and row["id"] == item_id)
        test = next(row for row in scored if row["reference_id"] == candidate_id and row["id"] == item_id)
        paired.append({
            "id": item_id,
            "control_similarity": base.get("centroid_similarity", 0.0),
            "candidate_similarity": test.get("centroid_similarity", 0.0),
            "similarity_delta": round(test.get("centroid_similarity", 0.0) - base.get("centroid_similarity", 0.0), 6),
            "control_cer": base.get("cer", 1.0),
            "candidate_cer": test.get("cer", 1.0),
        })
    result = {
        "style_target": target,
        "control": control,
        "candidate": candidate,
        "similarity_delta": round(candidate["similarity_mean"] - control["similarity_mean"], 6),
        "similarity_improved_count": sum(item["similarity_delta"] > 0 for item in paired),
        "cer_delta": round(candidate["cer_mean"] - control["cer_mean"], 6),
        "style_distance_delta": round(candidate["style_distance_mean"] - control["style_distance_mean"], 6),
        "pairs": paired,
        "items": scored,
    }
    result["passes"] = (
        candidate["count"] == 12
        and candidate["valid_count"] == 12
        and result["similarity_delta"] >= 0.03
        and result["similarity_improved_count"] >= 8
        and result["cer_delta"] <= 0.02
        and result["style_distance_delta"] <= 0.05
        and candidate["duration_guard_count"] == 0
        and candidate["repetition_count"] == 0
    )
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("control", "candidate", "similarity_delta", "similarity_improved_count", "cer_delta", "style_distance_delta", "passes")}, ensure_ascii=False))
    return 0 if result["passes"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
