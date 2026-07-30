#!/usr/bin/env python3
"""Build a local HTML/Markdown audition catalog for all 75 tournament outputs."""

from __future__ import annotations

import argparse
import html
import json
from collections import defaultdict
from pathlib import Path


HERE = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=Path, default=HERE / "reports" / "reference-tournament-scored.jsonl")
    parser.add_argument("--scores", type=Path, default=HERE / "reports" / "reference-tournament-scores.json")
    parser.add_argument("--html", type=Path, default=HERE / "reports" / "reference-catalog.html")
    parser.add_argument("--markdown", type=Path, default=HERE / "reports" / "reference-catalog.md")
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.rows.read_text(encoding="utf-8").splitlines() if line]
    report = json.loads(args.scores.read_text(encoding="utf-8"))
    aggregates = {item["reference_id"]: item for item in report["ranking"]}
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["reference_id"]].append(row)
    order = sorted(grouped, key=lambda key: (key != "control-current", -aggregates.get(key, {}).get("similarity_mean", 0), key))
    cards = []
    markdown = ["# Qwen3-TTS 参考音 75 条试听目录", "", "每个参考音含 3 条训练外探针。执行卡片中的 PowerShell 命令即可切换，下一句合成自动刷新。", ""]
    for reference_id in order:
        aggregate = aggregates.get(reference_id, {})
        title = html.escape(reference_id)
        rows_for_ref = sorted(grouped[reference_id], key=lambda row: int(row["probe_index"]))
        metrics = (
            f"相似度均值 {aggregate.get('similarity_mean', 0):.3f} · CER {aggregate.get('cer_mean', 0):.3f} · "
            f"时长均值 {aggregate.get('duration_mean_s', 0):.2f}s · 触顶 {aggregate.get('duration_guard_count', 0)}"
        )
        command = f"python scripts/qwen3-finetune/activate_reference.py --reference-id {reference_id}"
        audios = []
        for row in rows_for_ref:
            audio_path = Path(row["audio"]).resolve().as_posix()
            src = "file:///" + audio_path
            audios.append(
                f"<div class='probe'><b>探针 {row['probe_index']}</b> "
                f"CAM++ {row.get('centroid_similarity', 0):.3f} · CER {row.get('cer', 0):.3f} · "
                f"{row.get('duration_s', 0):.2f}s · RMS {row.get('rms', 0):.3f}"
                f"<br><audio controls preload='none' src='{html.escape(src, quote=True)}'></audio></div>"
            )
        cards.append(f"<section><h2>{title}</h2><p>{html.escape(metrics)}</p><code>{html.escape(command)}</code>{''.join(audios)}</section>")
        markdown.extend([f"## `{reference_id}`", "", metrics, "", f"```powershell\n{command}\n```", ""])
        markdown.extend([f"- 探针 {row['probe_index']}: [试听]({Path(row['audio']).resolve().as_uri()}) · CAM++ `{row.get('centroid_similarity', 0):.3f}` · CER `{row.get('cer', 0):.3f}` · `{row.get('duration_s', 0):.2f}s`" for row in rows_for_ref])
        markdown.append("")
    document = "<!doctype html><meta charset='utf-8'><title>Qwen3-TTS 参考音试听台</title><style>body{font:15px system-ui;max-width:980px;margin:24px auto;background:#fafafa;color:#222}section{background:white;border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}code{display:block;background:#f0f0f0;padding:8px;user-select:all}.probe{margin-top:10px;padding:8px;background:#f7f7f7;border-radius:6px}audio{width:100%;max-width:560px}</style>" + "".join(cards)
    args.html.write_text(document, encoding="utf-8")
    args.markdown.write_text("\n".join(markdown) + "\n", encoding="utf-8")
    print(json.dumps({"references": len(order), "samples": len(rows), "html": str(args.html.resolve()), "markdown": str(args.markdown.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
