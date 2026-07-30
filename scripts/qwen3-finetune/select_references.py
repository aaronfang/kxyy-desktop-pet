#!/usr/bin/env python3
"""Build a reference-free speaker centroid and rank clean reference clips."""

from __future__ import annotations

import argparse
import json
import math
import warnings
from collections import Counter
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


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
    value = result[0]["spk_embedding"]
    if hasattr(value, "cpu"):
        value = value.cpu().numpy()
    value = np.asarray(value, dtype=np.float32).reshape(-1)
    return value / (np.linalg.norm(value) + 1e-8)


def _prosody(audio: np.ndarray, sample_rate: int = 16000) -> dict[str, float]:
    frame_length = 1024
    hop_length = 256
    rms = librosa.feature.rms(
        y=audio, frame_length=frame_length, hop_length=hop_length
    )[0]
    noise_floor = float(np.percentile(rms, 10)) if rms.size else 0.0
    active = rms[rms >= max(0.006, noise_floor * 2.0)]
    active_rms = float(np.median(active)) if active.size else 0.0
    snr_proxy_db = 20.0 * math.log10((active_rms + 1e-6) / (noise_floor + 1e-6))
    try:
        f0 = librosa.yin(
            audio,
            fmin=80,
            fmax=500,
            sr=sample_rate,
            frame_length=2048,
            hop_length=hop_length,
        )
        plausible = f0[(f0 >= 100) & (f0 <= 450)]
    except Exception:
        plausible = np.asarray([], dtype=np.float32)
    return {
        "noise_floor": round(noise_floor, 6),
        "active_rms": round(active_rms, 6),
        "snr_proxy_db": round(float(np.clip(snr_proxy_db, 0, 60)), 3),
        "f0_median": round(float(np.median(plausible)), 2) if plausible.size else 0.0,
        "f0_iqr": round(
            float(np.percentile(plausible, 75) - np.percentile(plausible, 25)), 2
        )
        if plausible.size
        else 0.0,
    }


def _quality(row: dict, prosody: dict) -> float:
    duration_score = max(0.0, 1.0 - abs(float(row["duration_s"]) - 7.5) / 5.0)
    asr_score = float(np.clip((float(row["asr_avg_logprob"]) + 1.0) / 0.8, 0, 1))
    no_speech_score = 1.0 - float(np.clip(row["asr_no_speech_prob"] / 0.4, 0, 1))
    speech_score = max(0.0, 1.0 - abs(float(row["speech_ratio"]) - 0.78) / 0.35)
    snr_score = float(np.clip((prosody["snr_proxy_db"] - 8.0) / 22.0, 0, 1))
    pitch_score = 1.0 if 140 <= prosody["f0_median"] <= 360 else 0.3
    return (
        0.20 * duration_score
        + 0.25 * asr_score
        + 0.15 * no_speech_score
        + 0.15 * speech_score
        + 0.20 * snr_score
        + 0.05 * pitch_score
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=WORK / "scored.jsonl")
    parser.add_argument("--output-dir", type=Path, default=WORK / "ref-selection")
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--per-source", type=int, default=2)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    embedding_path = args.output_dir / "embeddings.jsonl"
    if args.reset:
        embedding_path.unlink(missing_ok=True)
    rows = [
        json.loads(line)
        for line in args.input.read_text(encoding="utf-8").splitlines()
        if line
    ]
    cached: dict[str, dict] = {}
    if embedding_path.is_file():
        cached = {
            item["id"]: item
            for item in (
                json.loads(line)
                for line in embedding_path.read_text(encoding="utf-8").splitlines()
                if line
            )
        }
        print(f"resume embeddings={len(cached)}/{len(rows)}", flush=True)

    from funasr import AutoModel

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = AutoModel(model="cam++", device="cuda", disable_update=True)
    with embedding_path.open("a", encoding="utf-8") as handle:
        for row in rows:
            if row["id"] in cached:
                continue
            audio = _audio16(Path(row["audio"]))
            item = {
                "id": row["id"],
                "embedding": _embedding(model, audio).round(7).tolist(),
                "prosody": _prosody(audio),
            }
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            handle.flush()
            cached[row["id"]] = item
            if len(cached) % 25 == 0 or len(cached) == len(rows):
                print(f"embedded {len(cached)}/{len(rows)}", flush=True)

    matrix = np.asarray([cached[row["id"]]["embedding"] for row in rows], dtype=np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-8
    neighbors = NearestNeighbors(n_neighbors=11, metric="cosine").fit(matrix)
    distances, _ = neighbors.kneighbors(matrix)
    density = 1.0 - distances[:, 1:].mean(axis=1)
    tenth_distance = distances[:, -1]
    eps = float(np.clip(np.percentile(tenth_distance, 65), 0.22, 0.40))
    labels = DBSCAN(eps=eps, min_samples=6, metric="cosine", n_jobs=-1).fit_predict(matrix)
    counts = Counter(int(label) for label in labels if label >= 0)
    if not counts:
        raise SystemExit("DBSCAN found no stable speaker cluster")
    cluster_label, cluster_size = counts.most_common(1)[0]
    cluster_mask = labels == cluster_label
    centroid = matrix[cluster_mask].mean(axis=0)
    centroid /= np.linalg.norm(centroid) + 1e-8
    centroid_similarity = matrix @ centroid
    np.save(args.output_dir / "speaker-centroid.npy", centroid)

    ranked = []
    for index, row in enumerate(rows):
        prosody = cached[row["id"]]["prosody"]
        quality = _quality(row, prosody)
        density_score = float(np.clip((density[index] - 0.45) / 0.35, 0, 1))
        centroid_score = float(np.clip((centroid_similarity[index] - 0.45) / 0.45, 0, 1))
        final_score = 0.52 * centroid_score + 0.18 * density_score + 0.30 * quality
        item = {
            **row,
            **prosody,
            "cluster": int(labels[index]),
            "cluster_member": bool(cluster_mask[index]),
            "centroid_similarity": round(float(centroid_similarity[index]), 6),
            "density_similarity": round(float(density[index]), 6),
            "quality_score": round(quality, 6),
            "selection_score": round(final_score, 6),
        }
        if (
            cluster_mask[index]
            and 5.0 <= float(row["duration_s"]) <= 11.0
            and float(row["asr_avg_logprob"]) >= -0.65
            and float(row["asr_no_speech_prob"]) <= 0.35
            and float(row["clip_ratio"]) <= 0.0005
            and 0.52 <= float(row["speech_ratio"]) <= 0.98
            and prosody["snr_proxy_db"] >= 10.0
            and 8 <= len(row["text"]) <= 80
        ):
            ranked.append(item)
    ranked.sort(key=lambda item: (-item["selection_score"], item["id"]))
    selected = []
    source_counts: Counter[str] = Counter()
    for item in ranked:
        if source_counts[item["source_id"]] >= args.per_source:
            continue
        selected.append(item)
        source_counts[item["source_id"]] += 1
        if len(selected) >= args.count:
            break
    if len(selected) < args.count:
        raise SystemExit(f"only {len(selected)} eligible references")
    output_path = args.output_dir / "candidates.jsonl"
    output_path.write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in selected),
        encoding="utf-8",
    )
    summary = {
        "input_count": len(rows),
        "embedding_dim": int(matrix.shape[1]),
        "dbscan_eps": round(eps, 6),
        "cluster_count": len(counts),
        "largest_cluster": cluster_size,
        "eligible_count": len(ranked),
        "selected_count": len(selected),
        "selected_sources": len(source_counts),
        "centroid_similarity": {
            "min": round(min(item["centroid_similarity"] for item in selected), 6),
            "mean": round(
                sum(item["centroid_similarity"] for item in selected) / len(selected), 6
            ),
            "max": round(max(item["centroid_similarity"] for item in selected), 6),
        },
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
