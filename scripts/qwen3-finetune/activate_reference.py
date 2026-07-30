#!/usr/bin/env python3
"""Switch the local Qwen reference to one of the 24 automatically tested clips."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
DEFAULT_OUTPUT = WORK / "active-reference.json"


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def main() -> int:
    parser = argparse.ArgumentParser(description="一键切换 Qwen3 参考音；下一句合成自动生效")
    parser.add_argument("--reference-id", required=True)
    parser.add_argument("--input", type=Path, default=HERE / "reports" / "reference-tournament.jsonl")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    rows = [row for row in _rows(args.input) if row["reference_id"] == args.reference_id]
    if len(rows) != 3 or any(row.get("status") != "ok" for row in rows):
        raise SystemExit("参考音必须有完整 3 条成功探针")
    for row in rows:
        if row.get("score_status") not in (None, "ok"):
            raise SystemExit("参考音包含评分失败探针")
    audio = Path(rows[0]["reference_audio"]).resolve()
    allowed = WORK.resolve()
    try:
        audio.relative_to(allowed)
    except ValueError as error:
        raise SystemExit("为避免误选，当前工具只允许切换 work/ 内的主播参考音") from error
    if not audio.is_file():
        raise SystemExit("参考音文件不存在")
    text = str(rows[0].get("reference_text") or "").strip()
    if not 8 <= len(text) <= 200:
        raise SystemExit("参考音文案长度不合格")
    manifest = {
        "schemaVersion": 1,
        "validationPasses": True,
        "selectionMode": "manual-gallery",
        "referenceId": args.reference_id,
        "audio": str(audio),
        "text": text,
        "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.is_file():
        args.output.with_suffix(".previous.json").write_text(args.output.read_text(encoding="utf-8"), encoding="utf-8")
    temporary = args.output.with_suffix(".next.json")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"active": args.reference_id, "next_generation": "automatic"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
