#!/usr/bin/env python3
"""Score reference-clone probes against an independently built speaker centroid."""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
import warnings
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
CONTROL_ID = "control-current"
EXPECTED_PROBES = 3
DURATION_GUARD_S = 19.0


def _audio16(path: Path) -> np.ndarray:
    audio, sample_rate = sf.read(str(path), always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = np.asarray(audio, dtype=np.float32)
    if sample_rate != 16000:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
    return audio.astype(np.float32)


def _embedding(model, audio: np.ndarray) -> np.ndarray:
    result = model.generate(input=audio)
    if not result or "spk_embedding" not in result[0]:
        raise RuntimeError("CAM++ returned no speaker embedding")
    value = result[0]["spk_embedding"]
    if hasattr(value, "cpu"):
        value = value.cpu().numpy()
    value = np.asarray(value, dtype=np.float32).reshape(-1)
    return value / (np.linalg.norm(value) + 1e-8)


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(char for char in text if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def _edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        for j, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def _transcribe(model: WhisperModel, path: Path) -> str:
    segments, _ = model.transcribe(
        str(path),
        language="zh",
        condition_on_previous_text=False,
        temperature=0.0,
        beam_size=1,
        best_of=1,
        vad_filter=False,
    )
    return "".join(segment.text for segment in segments)


def _is_repetitive(text: str) -> bool:
    text = _normalize(text)
    if len(text) < 12:
        return False
    if max(text.count(char) for char in set(text)) / len(text) >= 0.5:
        return True
    for width in range(1, min(7, len(text) // 4 + 1)):
        match = re.search(rf"(.{{{width}}})\1{{3,}}", text)
        if match and len(match.group(0)) / len(text) >= 0.65:
            return True
    return False


def _acoustics(audio: np.ndarray) -> dict[str, float]:
    if audio.size == 0:
        return {"rms": 0.0, "peak": 0.0, "clip_ratio": 0.0, "snr_proxy_db": 0.0}
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    clip_ratio = float(np.mean(np.abs(audio) >= 0.995))
    frames = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    noise_floor = float(np.percentile(frames, 10)) if frames.size else 0.0
    active = frames[frames >= max(0.006, noise_floor * 2.0)]
    active_rms = float(np.median(active)) if active.size else 0.0
    snr = 20.0 * math.log10((active_rms + 1e-6) / (noise_floor + 1e-6))
    return {
        "rms": round(rms, 7),
        "peak": round(peak, 7),
        "clip_ratio": round(clip_ratio, 7),
        "snr_proxy_db": round(float(np.clip(snr, 0, 60)), 3),
    }


def _aggregate(reference_id: str, rows: list[dict]) -> dict:
    valid = [row for row in rows if row.get("score_status") == "ok"]
    mean = lambda key, default=0.0: (
        sum(float(row[key]) for row in valid) / len(valid) if valid else default
    )
    return {
        "reference_id": reference_id,
        "source_id": rows[0].get("source_id") if rows else None,
        "probe_count": len(rows),
        "valid_count": len(valid),
        "similarity_mean": round(mean("centroid_similarity"), 6),
        "similarity_min": round(min((row["centroid_similarity"] for row in valid), default=0.0), 6),
        "cer_mean": round(mean("cer"), 6),
        "duration_mean_s": round(mean("duration_s"), 3),
        "duration_guard_count": sum(bool(row.get("hit_duration_guard")) for row in rows),
        "empty_count": sum(bool(row.get("empty_audio")) for row in rows),
        "repetition_count": sum(bool(row.get("repetitive_asr")) for row in rows),
        "clip_ratio_max": round(max((row.get("clip_ratio", 0.0) for row in valid), default=0.0), 7),
        "snr_proxy_db_min": round(min((row.get("snr_proxy_db", 0.0) for row in valid), default=0.0), 3),
    }


def _passes(candidate: dict, control: dict) -> tuple[bool, list[str]]:
    reasons = []
    if candidate["probe_count"] != EXPECTED_PROBES or candidate["valid_count"] != EXPECTED_PROBES:
        reasons.append("incomplete")
    if candidate["empty_count"]:
        reasons.append("empty_audio")
    if candidate["duration_guard_count"]:
        reasons.append("duration_guard")
    if candidate["repetition_count"]:
        reasons.append("repetition")
    if candidate["clip_ratio_max"] > 0.001:
        reasons.append("clipping")
    if candidate["snr_proxy_db_min"] < 8.0:
        reasons.append("low_snr")
    if candidate["similarity_mean"] - control["similarity_mean"] < 0.02:
        reasons.append("similarity_delta")
    if candidate["cer_mean"] - control["cer_mean"] > 0.02:
        reasons.append("cer_delta")
    return not reasons, reasons


def _self_test() -> None:
    control = {
        "similarity_mean": 0.70,
        "cer_mean": 0.05,
    }
    good = {
        "probe_count": 3,
        "valid_count": 3,
        "empty_count": 0,
        "duration_guard_count": 0,
        "repetition_count": 0,
        "clip_ratio_max": 0.0,
        "snr_proxy_db_min": 18.0,
        "similarity_mean": 0.74,
        "cer_mean": 0.05,
    }
    assert _passes(good, control)[0]
    for mutation, reason in (
        ({"valid_count": 2, "empty_count": 1}, "empty_audio"),
        ({"duration_guard_count": 1}, "duration_guard"),
        ({"cer_mean": 0.08}, "cer_delta"),
        ({"similarity_mean": 0.71}, "similarity_delta"),
        ({"repetition_count": 1}, "repetition"),
    ):
        bad = {**good, **mutation}
        passed, reasons = _passes(bad, control)
        assert not passed and reason in reasons, (mutation, reasons)
    print("self-test passed: empty/duration/CER/similarity/repetition failures rejected")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=HERE / "reports" / "reference-tournament.jsonl")
    parser.add_argument("--centroid", type=Path, default=WORK / "ref-selection" / "speaker-centroid.npy")
    parser.add_argument("--output", type=Path, default=HERE / "reports" / "reference-tournament-scores.json")
    parser.add_argument("--cache", type=Path, default=HERE / "reports" / "reference-tournament-scored.jsonl")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return 0
    source_rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    if args.reset:
        args.cache.unlink(missing_ok=True)
    cached = {}
    if args.cache.is_file():
        cached = {
            (row["reference_id"], int(row["probe_index"])): row
            for row in (json.loads(line) for line in args.cache.read_text(encoding="utf-8").splitlines() if line)
        }

    centroid = np.asarray(np.load(args.centroid), dtype=np.float32).reshape(-1)
    centroid /= np.linalg.norm(centroid) + 1e-8
    from funasr import AutoModel
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        speaker_model = AutoModel(model="cam++", device="cuda", disable_update=True)
    asr_model = WhisperModel("small", device="cuda", compute_type="float16")
    scored = []
    for source in source_rows:
        key = (source["reference_id"], int(source["probe_index"]))
        if key in cached:
            scored.append(cached[key])
            continue
        row = dict(source)
        try:
            audio = _audio16(Path(source["audio"]))
            acoustics = _acoustics(audio)
            asr = _transcribe(asr_model, Path(source["audio"])) if audio.size else ""
            expected = _normalize(source["text"])
            actual = _normalize(asr)
            embedding = _embedding(speaker_model, audio) if audio.size else np.zeros_like(centroid)
            row.update(
                score_status="ok" if audio.size else "failed",
                centroid_similarity=round(float(np.dot(embedding, centroid)), 6),
                cer=round(_edit_distance(expected, actual) / max(1, len(expected)), 6),
                asr=asr,
                empty_audio=bool(audio.size == 0 or acoustics["rms"] < 1e-5),
                repetitive_asr=_is_repetitive(asr),
                hit_duration_guard=float(source.get("duration_s", 0.0)) >= DURATION_GUARD_S,
                **acoustics,
            )
        except Exception as error:
            row.update(score_status="failed", score_error_type=type(error).__name__, empty_audio=True)
        scored.append(row)
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        args.cache.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in scored), encoding="utf-8")
        print(f"scored {len(scored)}/{len(source_rows)}", flush=True)

    grouped = defaultdict(list)
    for row in scored:
        grouped[row["reference_id"]].append(row)
    aggregates = [_aggregate(reference_id, rows) for reference_id, rows in grouped.items()]
    controls = [item for item in aggregates if item["reference_id"] == CONTROL_ID]
    if len(controls) != 1:
        raise SystemExit("exactly one control-current reference is required")
    control = controls[0]
    for item in aggregates:
        item["similarity_delta"] = round(item["similarity_mean"] - control["similarity_mean"], 6)
        item["cer_delta"] = round(item["cer_mean"] - control["cer_mean"], 6)
        if item["reference_id"] == CONTROL_ID:
            item.update(passes_tournament=False, rejection_reasons=["control"])
        else:
            passed, reasons = _passes(item, control)
            item.update(passes_tournament=passed, rejection_reasons=reasons)
    aggregates.sort(key=lambda item: (not item["passes_tournament"], -item["similarity_mean"], item["cer_mean"], item["reference_id"]))
    winners = [item for item in aggregates if item["passes_tournament"]]
    report = {
        "control": control,
        "winner": winners[0] if winners else None,
        "passing_count": len(winners),
        "ranking": aggregates,
        "thresholds": {"similarity_delta_min": 0.02, "cer_delta_max": 0.02, "duration_guard_s": DURATION_GUARD_S},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"control": control, "winner": report["winner"], "passing_count": len(winners)}, ensure_ascii=False))
    return 0 if winners else 2


if __name__ == "__main__":
    raise SystemExit(main())
