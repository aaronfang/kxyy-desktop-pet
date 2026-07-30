#!/usr/bin/env python3
"""Score candidate utterances against the authorized YuanYuan reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import warnings
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORK = HERE / "work"
DEFAULT_REF = (
    REPO
    / "scripts"
    / "persona-distill"
    / "sample_wav"
    / "kxyy-vocal-sample"
    / "kxyy-vocal-sample-12s.wav"
)


def _audio16(path: Path) -> np.ndarray:
    audio, sr = sf.read(str(path), always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = np.asarray(audio, dtype=np.float32)
    if sr != 16000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return audio.astype(np.float32)


def _embedding(model, audio: np.ndarray) -> np.ndarray:
    result = model.generate(input=audio)
    if not result:
        raise RuntimeError("CAM++ returned no result")
    emb = result[0].get("spk_embedding")
    if emb is None:
        raise RuntimeError("CAM++ returned no speaker embedding")
    if hasattr(emb, "cpu"):
        emb = emb.cpu().numpy()
    value = np.asarray(emb, dtype=np.float32).reshape(-1)
    return value / (np.linalg.norm(value) + 1e-8)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_checkpoint(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=WORK / "candidates.jsonl")
    parser.add_argument("--output", type=Path, default=WORK / "scored.jsonl")
    parser.add_argument("--reference", type=Path, default=DEFAULT_REF)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    checkpoint_path = args.output.with_suffix(".checkpoint.json")
    if args.reset:
        args.output.unlink(missing_ok=True)
        checkpoint_path.unlink(missing_ok=True)
    signature = {
        "input_sha256": _sha256(args.input),
        "reference_sha256": _sha256(args.reference),
        "device": args.device,
    }
    scored_rows: list[dict] = []
    if checkpoint_path.is_file():
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("signature") != signature:
            raise SystemExit("existing score checkpoint differs; pass --reset")
        scored_rows = [
            json.loads(line)
            for line in args.output.read_text(encoding="utf-8").splitlines()
            if line
        ]
        completed_count = int(checkpoint.get("completed_count", -1))
        if len(scored_rows) < completed_count:
            raise SystemExit("score checkpoint/output count mismatch; pass --reset")
        if len(scored_rows) > completed_count:
            scored_rows = scored_rows[:completed_count]
            args.output.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in scored_rows),
                encoding="utf-8",
            )
        print(f"resume scored={len(scored_rows)}", flush=True)
    elif args.output.exists():
        raise SystemExit("score output exists without checkpoint; pass --reset")

    from funasr import AutoModel

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = AutoModel(model="cam++", device=args.device, disable_update=True)
    ref = _embedding(model, _audio16(args.reference))
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line]
    completed_ids = {row["id"] for row in scored_rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("a", encoding="utf-8") as handle:
        for index, row in enumerate(rows, start=1):
            if row["id"] in completed_ids:
                continue
            emb = _embedding(model, _audio16(Path(row["audio"])))
            row["speaker_similarity"] = round(float(np.dot(emb, ref)), 6)
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            scored_rows.append(row)
            if len(scored_rows) % 25 == 0 or len(scored_rows) == len(rows):
                handle.flush()
                _write_checkpoint(
                    checkpoint_path,
                    {"signature": signature, "completed_count": len(scored_rows)},
                )
                print(f"scored {len(scored_rows)}/{len(rows)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
