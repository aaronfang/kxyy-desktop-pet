#!/usr/bin/env python3
"""Create timestamp-aligned Qwen3-TTS training candidates from anchor recordings.

Run with scripts/local-realtime/.venv-qwen3 so the already-installed OpenAI
Whisper runtime and CUDA build are reused. Outputs live under ignored work/.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import re
import shutil
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ANCHOR_DIR = REPO / "scripts" / "persona-distill" / "output" / "anchor"
WORK = HERE / "work"
PROMPT = "以下是一段中文直播对话，主播名叫元元。"


def _source_files() -> list[Path]:
    return sorted(
        p for p in ANCHOR_DIR.glob("*_anchor.wav") if "_chunk_" not in p.name
    )


def _spread(items: list[Path], count: int) -> list[Path]:
    if len(items) <= count:
        return items
    indexes = sorted({round(i * (len(items) - 1) / (count - 1)) for i in range(count)})
    return [items[i] for i in indexes]


def _clean_text(value: str) -> str:
    text = re.sub(r"<\|[^|]+\|>", "", value or "")
    text = re.sub(r"\s+", "", text).strip("，。！？、；：,.!?;: ")
    return text


def _merge_segments(segments: list[dict]) -> list[dict]:
    """Merge Whisper's short clauses without losing timestamp alignment."""
    merged: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        durations = [max(0.001, float(item["end"] - item["start"])) for item in current]
        weight = sum(durations)
        merged.append(
            {
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "text": "，".join(
                    value for value in (_clean_text(item.get("text", "")) for item in current) if value
                ),
                "avg_logprob": sum(
                    float(item.get("avg_logprob", -99.0)) * duration
                    for item, duration in zip(current, durations)
                )
                / weight,
                "no_speech_prob": sum(
                    float(item.get("no_speech_prob", 1.0)) * duration
                    for item, duration in zip(current, durations)
                )
                / weight,
                "compression_ratio": max(
                    float(item.get("compression_ratio", 99.0)) for item in current
                ),
                "parts": len(current),
            }
        )
        current = []

    for segment in segments:
        if not current:
            current = [segment]
            continue
        start = float(current[0]["start"])
        gap = float(segment["start"] - current[-1]["end"])
        combined_duration = float(segment["end"] - start)
        current_duration = float(current[-1]["end"] - start)
        should_merge = gap <= 0.50 and (
            current_duration < 3.0 or combined_duration <= 8.0
        )
        if should_merge:
            current.append(segment)
        else:
            flush()
            current = [segment]
    flush()
    return merged


def _audio_metrics(audio: np.ndarray, sr: int) -> dict[str, float]:
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64))) if audio.size else 0.0
    clip_ratio = float(np.mean(np.abs(audio) >= 0.999)) if audio.size else 1.0
    frame = max(1, int(sr * 0.02))
    usable = audio[: (audio.size // frame) * frame]
    if usable.size:
        frames = usable.reshape(-1, frame)
        frame_rms = np.sqrt(np.mean(np.square(frames), axis=1, dtype=np.float64))
        threshold = max(0.006, float(np.percentile(frame_rms, 20)) * 2.0)
        speech_ratio = float(np.mean(frame_rms >= threshold))
    else:
        speech_ratio = 0.0
    return {
        "peak": peak,
        "rms": rms,
        "clip_ratio": clip_ratio,
        "speech_ratio": speech_ratio,
    }


def _keep(segment: dict, text: str, metrics: dict[str, float]) -> tuple[bool, str]:
    duration = float(segment["end"] - segment["start"])
    meaningful = sum(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in text)
    if not 3.0 <= duration <= 12.0:
        return False, "duration"
    if meaningful < 4 or len(text) > 100:
        return False, "text_length"
    # Match Whisper's documented decoding defaults. Speaker purity is enforced
    # independently by the stricter CAM++ pass, so ASR confidence is not used
    # as a proxy for identity.
    if float(segment.get("avg_logprob", -99.0)) < -1.0:
        return False, "asr_logprob"
    if float(segment.get("no_speech_prob", 1.0)) > 0.60:
        return False, "no_speech"
    if float(segment.get("compression_ratio", 99.0)) > 2.4:
        return False, "repetition"
    if metrics["rms"] < 0.006 or metrics["peak"] < 0.02:
        return False, "low_energy"
    if metrics["clip_ratio"] > 0.001:
        return False, "clipping"
    if not 0.45 <= metrics["speech_ratio"] <= 0.99:
        return False, "speech_ratio"
    return True, "accepted"


def _load_transcriber(model_name: str, device: str, backend: str):
    """Prefer CTranslate2 on Windows while keeping the verified OpenAI fallback."""
    if backend in {"auto", "faster"}:
        try:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                model_name,
                device=device,
                compute_type="float16" if device == "cuda" else "int8",
            )

            def transcribe(audio: np.ndarray) -> list[dict]:
                segments, _ = model.transcribe(
                    audio,
                    language="zh",
                    initial_prompt=PROMPT,
                    condition_on_previous_text=False,
                    temperature=0.0,
                    beam_size=1,
                    best_of=1,
                    vad_filter=False,
                )
                return [dataclasses.asdict(segment) for segment in segments]

            return "faster-whisper", transcribe
        except (ImportError, RuntimeError):
            if backend == "faster":
                raise

    import whisper

    model = whisper.load_model(model_name, device=device)

    def transcribe(audio: np.ndarray) -> list[dict]:
        result = model.transcribe(
            audio,
            language="zh",
            initial_prompt=PROMPT,
            condition_on_previous_text=False,
            temperature=0.0,
            fp16=device == "cuda",
            verbose=None,
        )
        return result.get("segments") or []

    return "openai-whisper", transcribe


def _write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(path)


def _write_json_atomic(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--backend", choices=("auto", "faster", "openai"), default="auto")
    parser.add_argument("--sources", type=int, default=16)
    parser.add_argument("--seconds-per-source", type=int, default=600)
    parser.add_argument("--target-candidate-seconds", type=int, default=5400)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    candidate_dir = WORK / "candidates"
    if args.reset and WORK.exists():
        shutil.rmtree(WORK)
    candidate_dir.mkdir(parents=True, exist_ok=True)
    output_path = WORK / "candidates.jsonl"
    source_map_path = WORK / "source-map.json"
    checkpoint_path = WORK / "transcribe-checkpoint.json"

    sources = _spread(_source_files(), args.sources)
    if len(sources) < 2:
        raise SystemExit("need at least two combined anchor recordings")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    backend, transcribe = _load_transcriber(args.model, device, args.backend)
    print(f"backend={backend} device={device}", flush=True)
    signature = {
        "backend": backend,
        "model": args.model,
        "sources": args.sources,
        "seconds_per_source": args.seconds_per_source,
    }
    rows: list[dict] = []
    source_map: dict[str, str] = {}
    rejected: dict[str, int] = {}
    completed: set[str] = set()
    total_seconds = 0.0
    if checkpoint_path.is_file() and not args.reset:
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("signature") != signature:
            raise SystemExit("existing checkpoint parameters differ; pass --reset")
        rows = [
            json.loads(line)
            for line in output_path.read_text(encoding="utf-8").splitlines()
            if line
        ]
        source_map = json.loads(source_map_path.read_text(encoding="utf-8"))
        rejected = checkpoint.get("rejected") or {}
        completed = set(checkpoint.get("completed_sources") or [])
        total_seconds = float(checkpoint.get("candidate_seconds", 0.0))
        print(
            f"resume sources={len(completed)} candidates={len(rows)} "
            f"total={total_seconds:.1f}s",
            flush=True,
        )

    for source_index, source in enumerate(sources, start=1):
        source_id = f"src_{source_index:02d}"
        if source_id in completed:
            continue
        source_map[source_id] = source.name
        audio, sr = sf.read(str(source), always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        audio = np.asarray(audio, dtype=np.float32)
        if sr != 16000:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
            sr = 16000
        audio = audio[: args.seconds_per_source * sr]
        for segment in _merge_segments(transcribe(audio)):
            start = max(0, int(math.floor(float(segment["start"]) * sr)))
            end = min(audio.size, int(math.ceil(float(segment["end"]) * sr)))
            clip = audio[start:end]
            text = _clean_text(segment.get("text", ""))
            metrics = _audio_metrics(clip, sr)
            keep, reason = _keep(segment, text, metrics)
            if not keep:
                rejected[reason] = rejected.get(reason, 0) + 1
                continue
            clip24 = librosa.resample(clip, orig_sr=sr, target_sr=24000)
            digest = hashlib.sha256(
                f"{source_id}:{segment['start']:.3f}:{segment['end']:.3f}".encode()
            ).hexdigest()[:12]
            clip_path = candidate_dir / f"utt_{digest}.wav"
            sf.write(str(clip_path), clip24, 24000, subtype="PCM_16")
            duration = len(clip24) / 24000
            rows.append(
                {
                    "id": clip_path.stem,
                    "audio": str(clip_path.resolve()),
                    "source_id": source_id,
                    "source_date": re.match(r"\d{6}", source.name).group(0),
                    "start_s": round(float(segment["start"]), 3),
                    "end_s": round(float(segment["end"]), 3),
                    "duration_s": round(duration, 3),
                    "text": text,
                    "asr_avg_logprob": round(float(segment.get("avg_logprob", 0.0)), 4),
                    "asr_no_speech_prob": round(float(segment.get("no_speech_prob", 0.0)), 4),
                    **{k: round(v, 6) for k, v in metrics.items()},
                }
            )
            total_seconds += duration
        print(
            f"[{source_index}/{len(sources)}] {source_id}: "
            f"candidates={len(rows)} total={total_seconds:.1f}s",
            flush=True,
        )
        completed.add(source_id)
        _write_jsonl_atomic(output_path, rows)
        _write_json_atomic(source_map_path, source_map)
        _write_json_atomic(
            checkpoint_path,
            {
                "signature": signature,
                "completed_sources": sorted(completed),
                "candidate_count": len(rows),
                "candidate_seconds": round(total_seconds, 3),
                "rejected": rejected,
            },
        )
        if source_index >= 5 and total_seconds >= args.target_candidate_seconds:
            break

    _write_jsonl_atomic(output_path, rows)
    _write_json_atomic(source_map_path, source_map)
    summary = {
        "model": args.model,
        "backend": backend,
        "device": device,
        "sources_processed": len(completed),
        "candidate_count": len(rows),
        "candidate_seconds": round(total_seconds, 3),
        "thresholds": {
            "avg_logprob_min": -1.0,
            "no_speech_prob_max": 0.60,
            "compression_ratio_max": 2.4,
        },
        "rejected": rejected,
    }
    (WORK / "transcribe-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if total_seconds >= 1800 else 2


if __name__ == "__main__":
    raise SystemExit(main())
