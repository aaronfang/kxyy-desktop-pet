#!/usr/bin/env python3
"""Score fixed evaluation pairs with CAM++ similarity and character error rate."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
import warnings
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel


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


def _audio16(path: Path) -> np.ndarray:
    audio, sample_rate = sf.read(str(path), always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = np.asarray(audio, dtype=np.float32)
    if sample_rate != 16000:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=16000)
    return audio.astype(np.float32)


def _embedding(model, path: Path) -> np.ndarray:
    result = model.generate(input=_audio16(path))
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    baseline = [json.loads(line) for line in args.baseline.read_text(encoding="utf-8").splitlines() if line]
    candidate = [json.loads(line) for line in args.candidate.read_text(encoding="utf-8").splitlines() if line]
    if len(baseline) != 12 or len(candidate) != 12:
        raise SystemExit("both evaluation sets must contain exactly 12 rows")
    if [row["id"] for row in baseline] != [row["id"] for row in candidate]:
        raise SystemExit("evaluation ids differ")

    from funasr import AutoModel

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        speaker_model = AutoModel(model="cam++", device="cuda", disable_update=True)
    asr_model = WhisperModel("small", device="cuda", compute_type="float16")
    ref_embedding = _embedding(speaker_model, REF_AUDIO)
    results = []
    for base, fine in zip(baseline, candidate):
        row = {"id": base["id"], "text": base["text"]}
        for prefix, item in (("baseline", base), ("candidate", fine)):
            audio_path = Path(item["audio"])
            embedding = _embedding(speaker_model, audio_path)
            asr_text = _transcribe(asr_model, audio_path)
            expected = _normalize(item["text"])
            actual = _normalize(asr_text)
            row[f"{prefix}_similarity"] = round(float(np.dot(embedding, ref_embedding)), 6)
            row[f"{prefix}_cer"] = round(_edit_distance(expected, actual) / max(1, len(expected)), 6)
            row[f"{prefix}_asr"] = asr_text
            row[f"{prefix}_duration_s"] = item["duration_s"]
        row["similarity_delta"] = round(
            row["candidate_similarity"] - row["baseline_similarity"], 6
        )
        row["cer_delta"] = round(row["candidate_cer"] - row["baseline_cer"], 6)
        results.append(row)
        print(f"scored {len(results)}/12", flush=True)

    mean = lambda key: sum(row[key] for row in results) / len(results)
    summary = {
        "name": args.name,
        "baseline_similarity_mean": round(mean("baseline_similarity"), 6),
        "candidate_similarity_mean": round(mean("candidate_similarity"), 6),
        "similarity_mean_delta": round(mean("similarity_delta"), 6),
        "similarity_improved_count": sum(row["similarity_delta"] > 0 for row in results),
        "baseline_cer_mean": round(mean("baseline_cer"), 6),
        "candidate_cer_mean": round(mean("candidate_cer"), 6),
        "cer_mean_delta": round(mean("cer_delta"), 6),
        "duration_guard_count": sum(row["candidate_duration_s"] >= 19.0 for row in results),
    }
    summary["passes"] = (
        summary["similarity_mean_delta"] >= 0.03
        and summary["similarity_improved_count"] >= 8
        and summary["cer_mean_delta"] <= 0.02
        and summary["duration_guard_count"] == 0
    )
    output_dir = HERE / "reports" / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{args.name}.json").write_text(
        json.dumps({"summary": summary, "items": results}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["passes"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
