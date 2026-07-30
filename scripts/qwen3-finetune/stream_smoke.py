#!/usr/bin/env python3
"""Real faster-qwen3-tts custom-voice streaming smoke on CUDA."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch
from faster_qwen3_tts import FasterQwen3TTS


HERE = Path(__file__).resolve().parent


def _drain(generator) -> tuple[int, int, float, float]:
    started = time.perf_counter()
    first = None
    chunks = 0
    samples = 0
    for result in generator:
        if first is None:
            first = time.perf_counter()
        if not isinstance(result, tuple) or len(result) < 2:
            raise RuntimeError("unexpected provider result")
        audio = np.asarray(result[0], dtype=np.float32).reshape(-1)
        sample_rate = int(result[1])
        if sample_rate != 24000 or audio.size == 0:
            raise RuntimeError("invalid provider audio")
        chunks += 1
        samples += int(audio.size)
    ended = time.perf_counter()
    if first is None:
        raise RuntimeError("provider returned no chunks")
    return chunks, samples, first - started, ended - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--speaker", default="yuanyuan")
    parser.add_argument("--reference-manifest", type=Path)
    parser.add_argument("--run-name", default="stream-smoke")
    args = parser.parse_args()
    model = FasterQwen3TTS.from_pretrained(
        str(args.model),
        device="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
        backend="torch",
    )
    reference = None
    if args.reference_manifest:
        reference = json.loads(args.reference_manifest.read_text(encoding="utf-8"))
        audio = Path(reference["audio"])
        if (
            reference.get("schemaVersion") != 1
            or reference.get("validationPasses") is not True
            or hashlib.sha256(audio.read_bytes()).hexdigest() != reference.get("audioSha256")
        ):
            raise SystemExit("reference manifest is not validated")

    def create_stream(text: str, max_new_tokens: int):
        common = dict(
            text=text,
            language="Chinese",
            non_streaming_mode=True,
            max_new_tokens=max_new_tokens,
            chunk_size=24,
        )
        if reference:
            return model.generate_voice_clone_streaming(
                ref_audio=reference["audio"],
                ref_text=reference["text"],
                parity_mode=False,
                **common,
            )
        return model.generate_custom_voice_streaming(speaker=args.speaker, **common)

    _drain(create_stream("你好", 32))
    text = "大家下午好呀，今天想和你们认真聊一聊最近发生的事情，你们先别着急。"
    chunks, samples, ttfa, wall = _drain(
        create_stream(text, 240)
    )
    audio_seconds = samples / 24000
    result = {
        "chunks": chunks,
        "samples": samples,
        "audio_seconds": round(audio_seconds, 3),
        "ttfa_seconds": round(ttfa, 3),
        "wall_seconds": round(wall, 3),
        "rtf": round(wall / audio_seconds, 3),
    }
    result["passes"] = (
        result["chunks"] >= 2
        and result["ttfa_seconds"] < 3.0
        and result["rtf"] < 1.0
    )
    output_dir = HERE / "reports" / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{args.run_name}.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["passes"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
