#!/usr/bin/env python3
"""Validate the tournament winner on the frozen 12-prompt evaluation corpus."""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import soundfile as sf
import torch
from faster_qwen3_tts import FasterQwen3TTS


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORK = HERE / "work"
CONTROL_AUDIO = REPO / "scripts" / "persona-distill" / "sample_wav" / "kxyy-vocal-sample" / "kxyy-vocal-sample-12s.wav"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=WORK / "models" / "Qwen3-TTS-12Hz-1.7B-Base")
    parser.add_argument("--tournament-report", type=Path, default=HERE / "reports" / "reference-tournament-scores.json")
    parser.add_argument("--candidates", type=Path, default=WORK / "ref-selection" / "candidates.jsonl")
    parser.add_argument("--control-manifest", type=Path)
    parser.add_argument("--run-name", default="reference-validation")
    parser.add_argument("--max-new-tokens", type=int, default=240)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    winner = json.loads(args.tournament_report.read_text(encoding="utf-8")).get("winner")
    if not winner:
        raise SystemExit("tournament has no passing winner")
    candidates = {
        row["id"]: row
        for row in (json.loads(line) for line in args.candidates.read_text(encoding="utf-8").splitlines() if line)
    }
    selected = candidates.get(winner["reference_id"])
    if not selected:
        raise SystemExit("winning reference is absent from candidates")
    control = {
        "reference_id": "control-current",
        "reference_audio": str(CONTROL_AUDIO.resolve()),
        "reference_text": CONTROL_AUDIO.with_suffix(".txt").read_text(encoding="utf-8").strip(),
    }
    if args.control_manifest:
        item = json.loads(args.control_manifest.read_text(encoding="utf-8"))
        if item.get("validationPasses") is not True:
            raise SystemExit("control manifest is not validated")
        control.update(reference_audio=item["audio"], reference_text=item["text"])
    references = [
        control,
        {
            "reference_id": selected["id"],
            "reference_audio": selected["audio"],
            "reference_text": selected["text"],
        },
    ]
    prompts = json.loads((HERE / "eval_prompts.json").read_text(encoding="utf-8"))
    if len(prompts) != 12 or len(set(prompts)) != 12:
        raise SystemExit("evaluation corpus must contain exactly 12 unique prompts")
    output_dir = HERE / "reports" / "audio" / args.run_name
    metadata_path = HERE / "reports" / f"{args.run_name}.jsonl"
    if args.reset:
        if output_dir.exists():
            shutil.rmtree(output_dir)
        metadata_path.unlink(missing_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    completed = {}
    if metadata_path.is_file():
        completed = {
            (row["reference_id"], row["id"]): row
            for row in (json.loads(line) for line in metadata_path.read_text(encoding="utf-8").splitlines() if line)
        }
    rows = list(completed.values())
    model = FasterQwen3TTS.from_pretrained(
        str(args.model), device="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa", backend="torch"
    )
    total = len(references) * len(prompts)
    for reference_index, reference in enumerate(references):
        for prompt_index, text in enumerate(prompts, start=1):
            item_id = f"eval_{prompt_index:02d}"
            key = (reference["reference_id"], item_id)
            if key in completed:
                continue
            torch.manual_seed(20260730 + prompt_index)
            torch.cuda.manual_seed_all(20260730 + prompt_index)
            started = time.perf_counter()
            output_path = output_dir / f"{reference_index}_{reference['reference_id']}_{item_id}.wav"
            row = {**reference, "id": item_id, "probe_index": prompt_index, "text": text, "audio": str(output_path.resolve())}
            try:
                wavs, sample_rate = model.generate_voice_clone(
                    text=text,
                    language="Chinese",
                    ref_audio=reference["reference_audio"],
                    ref_text=reference["reference_text"],
                    max_new_tokens=args.max_new_tokens,
                    non_streaming_mode=True,
                    append_silence=True,
                )
                if not wavs:
                    raise RuntimeError("empty audio")
                sf.write(str(output_path), wavs[0], sample_rate, subtype="PCM_16")
                duration = len(wavs[0]) / sample_rate
                row.update(
                    status="ok",
                    sample_rate=int(sample_rate),
                    duration_s=round(duration, 3),
                    generation_s=round(time.perf_counter() - started, 3),
                    hit_duration_guard=duration >= args.max_new_tokens / 12 - 1.0,
                )
            except Exception as error:
                row.update(status="failed", error_type=type(error).__name__, generation_s=round(time.perf_counter() - started, 3))
            rows.append(row)
            completed[key] = row
            metadata_path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows), encoding="utf-8")
            print(f"generated {len(completed)}/{total} ref={reference['reference_id']} id={item_id} status={row['status']}", flush=True)
    return 0 if len(completed) == total and all(row["status"] == "ok" for row in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
