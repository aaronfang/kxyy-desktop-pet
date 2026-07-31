#!/usr/bin/env python3
"""Score repeated voice probes for speaker outliers and within-text variance."""

from __future__ import annotations

import argparse
import json
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

from score_reference_tournament import (
    _audio16,
    _edit_distance,
    _embedding,
    _is_repetitive,
    _normalize,
    _transcribe,
)


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def _parse_input(value: str) -> tuple[str, Path]:
    label, separator, raw_path = value.partition("=")
    if not separator or not label.strip() or not raw_path.strip():
        raise argparse.ArgumentTypeError("input must be LABEL=PATH")
    return label.strip(), Path(raw_path.strip())


def _summary(rows: list[dict], embeddings: dict[str, np.ndarray]) -> dict:
    valid = [row for row in rows if row.get("score_status") == "ok"]
    similarities = np.asarray(
        [row["centroid_similarity"] for row in valid], dtype=np.float64
    )
    prompt_groups = defaultdict(list)
    for row in valid:
        prompt_groups[row["prompt_id"]].append(embeddings[row["id"]])
    pairwise = []
    per_prompt = []
    for prompt_id, values in sorted(prompt_groups.items()):
        scores = [
            float(np.dot(values[left], values[right]))
            for left in range(len(values))
            for right in range(left + 1, len(values))
        ]
        pairwise.extend(scores)
        per_prompt.append(
            {
                "prompt_id": prompt_id,
                "repeat_count": len(values),
                "pairwise_mean": round(float(np.mean(scores)), 6) if scores else 0.0,
                "pairwise_min": round(float(np.min(scores)), 6) if scores else 0.0,
            }
        )
    return {
        "count": len(rows),
        "valid_count": len(valid),
        "similarity_mean": round(float(np.mean(similarities)), 6) if valid else 0.0,
        "similarity_min": round(float(np.min(similarities)), 6) if valid else 0.0,
        "similarity_p10": round(float(np.quantile(similarities, 0.10)), 6) if valid else 0.0,
        "similarity_std": round(float(np.std(similarities)), 6) if valid else 0.0,
        "pairwise_mean": round(float(np.mean(pairwise)), 6) if pairwise else 0.0,
        "pairwise_min": round(float(np.min(pairwise)), 6) if pairwise else 0.0,
        "cer_mean": round(
            sum(float(row["cer"]) for row in valid) / len(valid), 6
        ) if valid else 1.0,
        "duration_guard_count": sum(bool(row.get("hit_duration_guard")) for row in rows),
        "repetition_count": sum(bool(row.get("repetitive_asr")) for row in valid),
        "per_prompt": per_prompt,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", type=_parse_input, required=True)
    parser.add_argument("--centroid", type=Path, default=WORK / "ref-selection" / "speaker-centroid.npy")
    parser.add_argument("--run-name", required=True)
    args = parser.parse_args()
    labels = [label for label, _ in args.input]
    if len(labels) != len(set(labels)):
        raise SystemExit("input labels must be unique")

    centroid = np.asarray(np.load(args.centroid), dtype=np.float32).reshape(-1)
    centroid /= np.linalg.norm(centroid) + 1e-8
    from funasr import AutoModel
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        speaker_model = AutoModel(model="cam++", device="cuda", disable_update=True)
    asr_model = WhisperModel("small", device="cuda", compute_type="float16")

    result = {"schema_version": 1, "series": {}}
    for label, input_path in args.input:
        rows = [
            json.loads(line)
            for line in input_path.read_text(encoding="utf-8").splitlines()
            if line
        ]
        embeddings = {}
        scored = []
        for source in rows:
            item = dict(source)
            try:
                if source.get("status") != "ok":
                    raise RuntimeError("generation failed")
                audio_path = Path(source["audio"])
                audio = _audio16(audio_path)
                embedding = _embedding(speaker_model, audio)
                embeddings[source["id"]] = embedding
                asr = _transcribe(asr_model, audio_path)
                expected, actual = _normalize(source["text"]), _normalize(asr)
                item.update(
                    score_status="ok",
                    centroid_similarity=round(float(np.dot(embedding, centroid)), 6),
                    cer=round(_edit_distance(expected, actual) / max(1, len(expected)), 6),
                    repetitive_asr=_is_repetitive(asr),
                )
            except Exception as error:
                item.update(score_status="failed", score_error_type=type(error).__name__)
            scored.append(item)
            print(f"scored {label} {len(scored)}/{len(rows)}", flush=True)
        result["series"][label] = {
            "summary": _summary(scored, embeddings),
            "items": scored,
        }

    output_dir = HERE / "reports" / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{args.run_name}.json"
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {label: value["summary"] for label, value in result["series"].items()},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
