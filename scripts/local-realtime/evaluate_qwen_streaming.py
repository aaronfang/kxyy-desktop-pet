#!/usr/bin/env python3
"""Paired, local-only quality/latency evaluator for Windows Qwen streaming.

Generated WAV files stay under scripts/local-realtime/out (gitignored). The JSON
report deliberately contains only candidate/case ids and aggregate numbers: no
reference path, prompt text, transcript, or recognized text is serialized.
"""

from __future__ import annotations

import argparse
from array import array
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys
import time
import wave


OUTPUT_RATE = 24000
INPUT_RATE = 16000
TTFA_P95_LIMIT_MS = 1000.0
RTF_P95_LIMIT = 0.90
SIGNIFICANT_IMPROVEMENT = 0.20
MAX_OTHER_METRIC_REGRESSION = 0.05

# Synthetic text only. Never serialize these strings into the report.
CORPUS = (
    "爸爸把白布包摆在北边，别把八百块补贴报错。",
    "早晨坐直再仔细找，出租车正从十字路口左转。",
    "支持持续测试，吃葡萄不吐葡萄皮，也别着急停顿。",
    "哥哥刚刚告诉可可，快把咖啡和饼干各拿一份。",
    "请清楚区分机器、天气、脾气、日期和第七期。",
    "今天是二零二六年七月二十九日，版本是零点二点四四。",
    "Windows eleven 和 RTX fifty eighty 正在进行实时语音测试。",
    "小石狮子守着十只纸狮子，四十四个字要一个不少。",
    "你先别急，我会慢慢解释清楚，然后继续陪你聊天。",
    "突然停顿以后重新开始，前后两个短句都要发音完整。",
    "春风吹过池塘，知了在树枝上轻轻叫着，声音清楚自然。",
    "如果某个音节只说了一半，识别结果就可能漏字或者错字。",
)


@dataclass(frozen=True, slots=True)
class Candidate:
    candidate_id: str
    chunk_size: int
    non_streaming_mode: bool
    parity_mode: bool = False
    eligible: bool = True


CANDIDATES = (
    Candidate("fast12-full", 12, True),
    Candidate("fast16-full", 16, True),
    Candidate("fast24-full", 24, True),
    Candidate("fast36-full", 36, True),
    Candidate("fast12-feed", 12, False),
)


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    rank = max(1, math.ceil(len(ordered) * percentile_value / 100.0))
    return ordered[min(len(ordered), rank) - 1]


def normalize_text(value: str) -> str:
    return "".join(
        char.lower()
        for char in str(value or "")
        if "\u4e00" <= char <= "\u9fff" or char.isascii() and char.isalnum()
    )


def edit_counts(reference: str, hypothesis: str) -> dict[str, int]:
    """Levenshtein counts with deterministic substitution/deletion/insertion ties."""
    reference = normalize_text(reference)
    hypothesis = normalize_text(hypothesis)
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    dp: list[list[tuple[int, int, int, int]]] = [
        [(0, 0, 0, 0) for _ in range(cols)] for _ in range(rows)
    ]
    for row in range(1, rows):
        dp[row][0] = (row, row, 0, 0)
    for col in range(1, cols):
        dp[0][col] = (col, 0, 0, col)
    for row in range(1, rows):
        for col in range(1, cols):
            if reference[row - 1] == hypothesis[col - 1]:
                dp[row][col] = dp[row - 1][col - 1]
                continue
            total, deletes, substitutes, inserts = dp[row - 1][col - 1]
            choices = [
                (total + 1, deletes, substitutes + 1, inserts),
            ]
            total, deletes, substitutes, inserts = dp[row - 1][col]
            choices.append((total + 1, deletes + 1, substitutes, inserts))
            total, deletes, substitutes, inserts = dp[row][col - 1]
            choices.append((total + 1, deletes, substitutes, inserts + 1))
            dp[row][col] = min(choices)
    total, deletes, substitutes, inserts = dp[-1][-1]
    return {
        "referenceChars": len(reference),
        "edits": total,
        "deletions": deletes,
        "substitutions": substitutes,
        "insertions": inserts,
    }


def pcm_boundary_ratio(pcm_chunks: list[bytes]) -> float:
    """Boundary sample jumps divided by the p95 ordinary within-chunk derivative."""
    boundary_jumps: list[float] = []
    interior_jumps: list[float] = []
    previous_last: int | None = None
    for pcm in pcm_chunks:
        samples = array("h")
        samples.frombytes(pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        if not samples:
            continue
        if previous_last is not None:
            boundary_jumps.append(abs(int(samples[0]) - previous_last))
        stride = max(1, (len(samples) - 1) // 4096)
        interior_jumps.extend(
            abs(int(samples[index + 1]) - int(samples[index]))
            for index in range(0, len(samples) - 1, stride)
        )
        previous_last = int(samples[-1])
    if not boundary_jumps:
        return 0.0
    interior_p95 = percentile(interior_jumps, 95) or 1.0
    return float(percentile(boundary_jumps, 95) or 0.0) / max(1.0, interior_p95)


def summarize_candidate(candidate_id: str, cases: list[dict]) -> dict:
    failures = sum(1 for case in cases if case.get("failed"))
    reference_chars = sum(int(case.get("referenceChars") or 0) for case in cases)
    edits = sum(int(case.get("edits") or 0) for case in cases)
    deletions = sum(int(case.get("deletions") or 0) for case in cases)
    ttfa = [float(case["ttfaMs"]) for case in cases if not case.get("failed")]
    rtf = [float(case["rtf"]) for case in cases if not case.get("failed")]
    boundaries = [
        float(case["boundaryRatio"]) for case in cases if not case.get("failed")
    ]
    cer = edits / max(1, reference_chars)
    deletion_rate = deletions / max(1, reference_chars)
    summary = {
        "candidateId": candidate_id,
        "cases": len(cases),
        "failures": failures,
        "ttfaP50Ms": percentile(ttfa, 50),
        "ttfaP95Ms": percentile(ttfa, 95),
        "rtfP50": percentile(rtf, 50),
        "rtfP95": percentile(rtf, 95),
        "cer": cer,
        "deletionRate": deletion_rate,
        "boundaryRatioP95": percentile(boundaries, 95),
    }
    summary["realtimeQualified"] = bool(
        cases
        and failures == 0
        and summary["ttfaP95Ms"] is not None
        and summary["ttfaP95Ms"] <= TTFA_P95_LIMIT_MS
        and summary["rtfP95"] is not None
        and summary["rtfP95"] <= RTF_P95_LIMIT
    )
    return summary


def select_winner(summaries: list[dict], baseline_id: str = "fast12-full") -> str:
    by_id = {summary["candidateId"]: summary for summary in summaries}
    baseline = by_id[baseline_id]
    qualified = [summary for summary in summaries if summary["realtimeQualified"]]
    if not baseline["realtimeQualified"]:
        qualified.sort(
            key=lambda item: (
                item["deletionRate"],
                item["cer"],
                item["boundaryRatioP95"],
                item["ttfaP95Ms"],
            )
        )
        return qualified[0]["candidateId"] if qualified else baseline_id
    alternatives = []
    for candidate in qualified:
        if candidate["candidateId"] == baseline_id:
            continue
        deletion_improvement = (
            (baseline["deletionRate"] - candidate["deletionRate"])
            / max(baseline["deletionRate"], 1e-12)
            if baseline["deletionRate"] > 0
            else 0.0
        )
        cer_improvement = (
            (baseline["cer"] - candidate["cer"]) / max(baseline["cer"], 1e-12)
            if baseline["cer"] > 0
            else 0.0
        )
        deletion_regression = (
            (candidate["deletionRate"] - baseline["deletionRate"])
            / max(baseline["deletionRate"], 1e-12)
            if baseline["deletionRate"] > 0
            else (1.0 if candidate["deletionRate"] > 0 else 0.0)
        )
        cer_regression = (
            (candidate["cer"] - baseline["cer"]) / max(baseline["cer"], 1e-12)
            if baseline["cer"] > 0
            else (1.0 if candidate["cer"] > 0 else 0.0)
        )
        significant = (
            deletion_improvement >= SIGNIFICANT_IMPROVEMENT
            and cer_regression <= MAX_OTHER_METRIC_REGRESSION
        ) or (
            cer_improvement >= SIGNIFICANT_IMPROVEMENT
            and deletion_regression <= MAX_OTHER_METRIC_REGRESSION
        )
        if significant:
            alternatives.append(candidate)
    if not alternatives:
        return baseline_id
    alternatives.sort(
        key=lambda item: (
            item["deletionRate"],
            item["cer"],
            item["boundaryRatioP95"],
            item["ttfaP95Ms"],
        )
    )
    return alternatives[0]["candidateId"]


def _float_audio_to_pcm(audio, sample_rate: int) -> bytes:
    import numpy as np

    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if sample_rate != OUTPUT_RATE and values.size > 1:
        size = max(1, int(round(values.size * OUTPUT_RATE / sample_rate)))
        values = np.interp(
            np.linspace(0.0, 1.0, num=size, endpoint=False),
            np.linspace(0.0, 1.0, num=values.size, endpoint=False),
            values,
        ).astype(np.float32)
    return (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _pcm24k_to_16k(pcm: bytes) -> bytes:
    import numpy as np

    values = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    if values.size < 2:
        return b""
    size = max(1, int(round(values.size * INPUT_RATE / OUTPUT_RATE)))
    converted = np.interp(
        np.linspace(0.0, 1.0, num=size, endpoint=False),
        np.linspace(0.0, 1.0, num=values.size, endpoint=False),
        values,
    )
    return np.clip(converted, -32768, 32767).astype("<i2").tobytes()


def _write_wav(path: Path, pcm: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(OUTPUT_RATE)
        output.writeframes(pcm)


def _sensevoice_root() -> Path:
    configured = (os.environ.get("KXYY_ASR_RUNTIME_ROOT") or "").strip()
    if configured:
        return Path(configured)
    appdata = (os.environ.get("APPDATA") or "").strip()
    if not appdata:
        raise RuntimeError("sensevoice_runtime_missing")
    return Path(appdata) / "com.aaronfang.kxyydesktoppet" / "sensevoice-asr-runtime"


def _load_runtime():
    from concurrent.futures import ThreadPoolExecutor

    import asr_adapter
    import tts_qwen3_torch as tts

    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen-ab")
    selected_model = tts._resolve_model()
    tts.configure_from_settings(pool)
    if not tts._faster_streaming:
        pool.shutdown(wait=True)
        raise RuntimeError("faster_streaming_unavailable")
    recognizer = asr_adapter.SenseVoiceAdapter.from_runtime_root(_sensevoice_root())
    model_class = (
        "qwen3-tts-1.7b-base"
        if "1.7B-Base" in selected_model
        else "qwen3-tts-0.6b-base"
    )
    return tts, tts._model, recognizer, pool, model_class


def _generate_case(tts, model, recognizer, candidate: Candidate, text: str, seed: int):
    import torch

    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    started = time.perf_counter()
    first_at = None
    pcm_chunks: list[bytes] = []
    generator = model.generate_voice_clone_streaming(
        text=text,
        language=tts._language,
        ref_audio=str(tts._ref_wav),
        ref_text=tts._ref_text,
        max_new_tokens=tts.FASTER_MAX_NEW_TOKENS,
        non_streaming_mode=candidate.non_streaming_mode,
        chunk_size=candidate.chunk_size,
        parity_mode=candidate.parity_mode,
    )
    try:
        for audio, rate, _timing in generator:
            if first_at is None:
                first_at = time.perf_counter()
            pcm = _float_audio_to_pcm(audio, int(rate))
            if pcm:
                pcm_chunks.append(pcm)
    finally:
        close = getattr(generator, "close", None)
        if callable(close):
            close()
    ended = time.perf_counter()
    pcm = b"".join(pcm_chunks)
    if first_at is None or not pcm:
        raise RuntimeError("empty_audio")
    audio_seconds = len(pcm) / 2 / OUTPUT_RATE
    hypothesis = recognizer.transcribe(_pcm24k_to_16k(pcm)).text
    counts = edit_counts(text, hypothesis)
    return {
        **counts,
        "ttfaMs": (first_at - started) * 1000.0,
        "rtf": (ended - started) / max(audio_seconds, 1e-9),
        "audioSeconds": audio_seconds,
        "boundaryRatio": pcm_boundary_ratio(pcm_chunks),
        "pcm": pcm,
    }


def run_matrix(
    *, rounds: int, output_dir: Path, quick: bool = False, core_only: bool = False
) -> dict:
    tts, model, recognizer, pool, model_class = _load_runtime()
    corpus = CORPUS[:3] if quick else CORPUS
    candidates = CANDIDATES[:3] if quick or core_only else CANDIDATES
    all_cases: dict[str, list[dict]] = {item.candidate_id: [] for item in candidates}
    try:
        for round_index in range(rounds):
            for case_index, text in enumerate(corpus):
                seed = 20260729 + round_index * 1000 + case_index
                for candidate in candidates:
                    case_id = f"r{round_index + 1:02d}-c{case_index + 1:02d}"
                    try:
                        result = _generate_case(
                            tts, model, recognizer, candidate, text, seed
                        )
                        pcm = result.pop("pcm")
                        if case_index < 3:
                            _write_wav(
                                output_dir / candidate.candidate_id / f"{case_id}.wav",
                                pcm,
                            )
                        result.update({"caseId": case_id, "failed": False})
                    except Exception:
                        result = {
                            "caseId": case_id,
                            "failed": True,
                            "referenceChars": len(normalize_text(text)),
                            "edits": len(normalize_text(text)),
                            "deletions": len(normalize_text(text)),
                            "substitutions": 0,
                            "insertions": 0,
                        }
                    all_cases[candidate.candidate_id].append(result)
                    safe = all_cases[candidate.candidate_id][-1]
                    print(
                        "CASE "
                        f"candidate={candidate.candidate_id} id={case_id} "
                        f"failed={str(safe['failed']).lower()}"
                    )
    finally:
        pool.shutdown(wait=True)
    summaries = [
        summarize_candidate(candidate.candidate_id, all_cases[candidate.candidate_id])
        for candidate in candidates
    ]
    winner = select_winner(summaries)
    report = {
        "schemaVersion": 1,
        "runtime": {
            "deviceClass": "windows-cuda",
            "modelClass": model_class,
            "asr": "sensevoice-sherpa-onnx",
        },
        "policy": {
            "ttfaP95LimitMs": TTFA_P95_LIMIT_MS,
            "rtfP95Limit": RTF_P95_LIMIT,
            "significantImprovement": SIGNIFICANT_IMPROVEMENT,
            "maxOtherMetricRegression": MAX_OTHER_METRIC_REGRESSION,
        },
        "rounds": rounds,
        "corpusCases": len(corpus),
        "summaries": summaries,
        "winner": winner,
        "cases": all_cases,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--core-only", action="store_true")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "out" / "qwen-streaming-ab",
    )
    args = parser.parse_args()
    report = run_matrix(
        rounds=args.rounds,
        output_dir=args.output,
        quick=args.quick,
        core_only=args.core_only,
    )
    print("SUMMARY " + json.dumps({"winner": report["winner"], "summaries": report["summaries"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
