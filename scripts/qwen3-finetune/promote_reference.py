#!/usr/bin/env python3
"""Promote only a fully validated reference into the local streaming backend."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"


def _build_manifest(report: dict, candidates: dict[str, dict]) -> dict:
    if report.get("passes") is not True:
        raise ValueError("validation gate did not pass")
    candidate = report.get("candidate") or {}
    reference_id = candidate.get("reference_id")
    source = candidates.get(reference_id)
    if not source:
        raise ValueError("validated reference is absent from candidates")
    audio = Path(source["audio"]).resolve()
    audio.relative_to(WORK.resolve())
    if not audio.is_file():
        raise ValueError("validated reference audio is missing")
    text = str(source.get("text") or "").strip()
    if not 8 <= len(text) <= 200:
        raise ValueError("validated reference transcript is invalid")
    return {
        "schemaVersion": 1,
        "validationPasses": True,
        "referenceId": reference_id,
        "audio": str(audio),
        "text": text,
        "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
    }


def _self_test() -> None:
    with tempfile.TemporaryDirectory(dir=WORK) as temp_dir:
        audio = Path(temp_dir) / "fake.wav"
        audio.write_bytes(b"not-real-audio")
        candidates = {"winner": {"audio": str(audio), "text": "这是一条长度足够的精确参考文案"}}
        try:
            _build_manifest({"passes": False, "candidate": {"reference_id": "winner"}}, candidates)
        except ValueError as error:
            assert "did not pass" in str(error)
        else:
            raise AssertionError("failed validation was promoted")
    print("self-test passed: failed validation cannot be promoted")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=HERE / "reports" / "reference-validation-scores.json")
    parser.add_argument("--candidates", type=Path, default=WORK / "ref-selection" / "candidates.jsonl")
    parser.add_argument("--output", type=Path, default=WORK / "active-reference.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    if args.self_test:
        _self_test()
        return 0
    report = json.loads(args.report.read_text(encoding="utf-8"))
    candidates = {
        row["id"]: row
        for row in (json.loads(line) for line in args.candidates.read_text(encoding="utf-8").splitlines() if line)
    }
    manifest = _build_manifest(report, candidates)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"promoted": manifest["referenceId"], "manifest": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
