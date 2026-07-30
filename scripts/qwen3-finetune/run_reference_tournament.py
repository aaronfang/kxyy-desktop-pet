#!/usr/bin/env python3
"""Synthesize fixed training-external probes for automatic reference selection."""

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
CONTROL_AUDIO = (
    REPO
    / "scripts"
    / "persona-distill"
    / "sample_wav"
    / "kxyy-vocal-sample"
    / "kxyy-vocal-sample-12s.wav"
)
CONTROL_TEXT_PATH = CONTROL_AUDIO.with_suffix(".txt")
PROBES = [
    "刚才外面好像下雨了，你们那边天气怎么样？",
    "我觉得很多事情不用一下子想明白，慢慢来，先照顾好自己的心情。",
    "欢迎刚进直播间的朋友，今天我们轻松一点，想到什么就聊什么。",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        type=Path,
        default=WORK / "models" / "Qwen3-TTS-12Hz-1.7B-Base",
    )
    parser.add_argument(
        "--candidates", type=Path, default=WORK / "ref-selection" / "candidates.jsonl"
    )
    parser.add_argument("--run-name", default="reference-tournament")
    parser.add_argument("--control-manifest", type=Path)
    parser.add_argument("--max-new-tokens", type=int, default=240)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()
    candidates = [
        json.loads(line)
        for line in args.candidates.read_text(encoding="utf-8").splitlines()
        if line
    ]
    control = {
        "id": "control-current",
        "audio": str(CONTROL_AUDIO.resolve()),
        "text": CONTROL_TEXT_PATH.read_text(encoding="utf-8").strip(),
        "source_id": "control",
    }
    if args.control_manifest:
        item = json.loads(args.control_manifest.read_text(encoding="utf-8"))
        if item.get("validationPasses") is not True:
            raise SystemExit("control manifest is not validated")
        control.update(audio=item["audio"], text=item["text"])
    controls = [control]
    references = controls + candidates
    output_dir = HERE / "reports" / "audio" / args.run_name
    metadata_path = HERE / "reports" / f"{args.run_name}.jsonl"
    if args.reset:
        if output_dir.exists():
            shutil.rmtree(output_dir)
        metadata_path.unlink(missing_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    completed: dict[tuple[str, int], dict] = {}
    if metadata_path.is_file():
        completed = {
            (row["reference_id"], int(row["probe_index"])): row
            for row in (
                json.loads(line)
                for line in metadata_path.read_text(encoding="utf-8").splitlines()
                if line
            )
        }
        print(f"resume outputs={len(completed)}/{len(references) * len(PROBES)}", flush=True)

    model = FasterQwen3TTS.from_pretrained(
        str(args.model),
        device="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
        backend="torch",
    )
    rows = list(completed.values())
    total = len(references) * len(PROBES)
    for ref_index, reference in enumerate(references):
        for probe_index, text in enumerate(PROBES, start=1):
            key = (reference["id"], probe_index)
            if key in completed:
                continue
            torch.manual_seed(20260730 + probe_index)
            torch.cuda.manual_seed_all(20260730 + probe_index)
            started = time.perf_counter()
            output_path = output_dir / f"{ref_index:02d}_{reference['id']}_p{probe_index}.wav"
            row = {
                "reference_id": reference["id"],
                "reference_audio": reference["audio"],
                "reference_text": reference["text"],
                "source_id": reference.get("source_id"),
                "probe_index": probe_index,
                "text": text,
                "audio": str(output_path.resolve()),
            }
            try:
                wavs, sample_rate = model.generate_voice_clone(
                    text=text,
                    language="Chinese",
                    ref_audio=reference["audio"],
                    ref_text=reference["text"],
                    max_new_tokens=args.max_new_tokens,
                    non_streaming_mode=True,
                    append_silence=True,
                )
                if not wavs:
                    raise RuntimeError("empty audio")
                sf.write(str(output_path), wavs[0], sample_rate, subtype="PCM_16")
                row.update(
                    status="ok",
                    sample_rate=int(sample_rate),
                    duration_s=round(len(wavs[0]) / sample_rate, 3),
                    generation_s=round(time.perf_counter() - started, 3),
                )
            except Exception as error:
                row.update(
                    status="failed",
                    error_type=type(error).__name__,
                    generation_s=round(time.perf_counter() - started, 3),
                )
            rows.append(row)
            completed[key] = row
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows),
                encoding="utf-8",
            )
            print(
                f"generated {len(completed)}/{total} ref={reference['id']} "
                f"probe={probe_index} status={row['status']}",
                flush=True,
            )
    return 0 if all(row["status"] == "ok" for row in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
