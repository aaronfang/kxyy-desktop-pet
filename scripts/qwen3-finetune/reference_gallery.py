#!/usr/bin/env python3
"""Local-only gallery for listening to and promoting the 75 reference probes."""

from __future__ import annotations

import argparse
import hashlib
import json
import threading
import webbrowser
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
REPORTS = HERE / "reports"
PROBES = REPORTS / "audio" / "reference-tournament"
SCORED = REPORTS / "reference-tournament-scored.jsonl"
ACTIVE = WORK / "active-reference.json"


def _load_rows() -> list[dict]:
    if not SCORED.is_file():
        raise SystemExit(f"missing scored outputs: {SCORED}")
    rows = [json.loads(line) for line in SCORED.read_text(encoding="utf-8").splitlines() if line]
    if len(rows) != 75:
        raise SystemExit(f"expected 75 scored probes, found {len(rows)}")
    aggregates = {}
    report = REPORTS / "reference-tournament-scores.json"
    if report.is_file():
        aggregates = {
            item["reference_id"]: item
            for item in json.loads(report.read_text(encoding="utf-8"))["ranking"]
        }
    for row in rows:
        row["aggregate"] = aggregates.get(row["reference_id"], {})
        path = Path(row["audio"]).resolve()
        path.relative_to(PROBES.resolve())
        row["audio_file"] = path.name
    return rows


def _promote(reference_id: str, rows: list[dict]) -> dict:
    matching = [row for row in rows if row["reference_id"] == reference_id]
    if not matching:
        raise ValueError("unknown reference")
    row = matching[0]
    if reference_id == "control-current":
        raise ValueError("control reference cannot replace the active candidate")
    audio = Path(row["reference_audio"]).resolve()
    audio.relative_to((WORK / "candidates").resolve())
    if not audio.is_file():
        raise ValueError("reference audio is missing")
    text = str(row.get("reference_text") or "").strip()
    if not 8 <= len(text) <= 200:
        raise ValueError("reference transcript is invalid")
    manifest = {
        "schemaVersion": 1,
        "validationPasses": True,
        "selectionMode": "manual-gallery",
        "referenceId": reference_id,
        "audio": str(audio),
        "text": text,
        "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
    }
    ACTIVE.parent.mkdir(parents=True, exist_ok=True)
    temporary = ACTIVE.with_suffix(".manual.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(ACTIVE)
    return {"referenceId": reference_id, "selectionMode": "manual-gallery"}


PAGE = r"""<!doctype html>
<meta charset="utf-8">
<title>Qwen3 reference gallery</title>
<style>
body{font:14px system-ui,sans-serif;background:#f5f6f8;color:#202124;margin:20px}
h1{margin:0 0 6px}.hint{color:#5f6368;margin-bottom:14px}
.toolbar{position:sticky;top:0;background:#f5f6f8;padding:10px 0;z-index:2}
input,select{padding:7px;border:1px solid #bbb;border-radius:6px;margin-right:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(390px,1fr));gap:12px}
.card{background:white;border:1px solid #ddd;border-radius:8px;padding:12px;box-shadow:0 1px 2px #0001}
.bad{border-color:#d93025}.pass{border-color:#188038}.title{font-weight:700}
.meta{color:#5f6368;line-height:1.55;margin:5px 0}.scores{font:12px ui-monospace,monospace;white-space:pre-wrap}
.row{display:flex;align-items:center;gap:8px;margin-top:8px}button{background:#1769e0;color:#fff;border:0;border-radius:6px;padding:7px 10px;cursor:pointer}button:hover{background:#0b57d0}audio{width:100%;margin-top:8px}
</style>
<h1>Qwen3 参考音试听画廊</h1>
<div class="hint">75 条训练外探针。点击“用此参考音”会替换本地 active reference；下一句合成即生效，无需重启。</div>
<div class="toolbar"><input id="q" placeholder="筛选 reference id / 文本"><select id="sort"><option value="sim">相似度优先</option><option value="cer">CER 优先</option><option value="duration">时长</option><option value="snr">SNR</option></select><span id="count"></span></div>
<div id="app" class="grid"></div>
<script>
let rows=[];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){
 const q=document.querySelector('#q').value.trim().toLowerCase(),sort=document.querySelector('#sort').value;
 let a=rows.filter(x=>!q||`${x.reference_id} ${x.text}`.toLowerCase().includes(q));
 a.sort((x,y)=>sort==='cer'?x.cer-y.cer:sort==='duration'?x.duration_s-y.duration_s:sort==='snr'?y.snr_proxy_db-x.snr_proxy_db:y.centroid_similarity-x.centroid_similarity);
 document.querySelector('#count').textContent=`显示 ${a.length}/${rows.length}`;
 document.querySelector('#app').innerHTML=a.map((x,i)=>{
  let g=x.aggregate||{},cls=g.passes_tournament?'pass':(x.hit_duration_guard||x.repetitive_asr?'bad':'');
  let group=g.similarity_delta===undefined?'':`组均值 ΔCAM ${Number(g.similarity_delta).toFixed(4)} | ΔCER ${Number(g.cer_delta).toFixed(3)} | ${g.passes_tournament?'PASS':'REJECT '+(g.rejection_reasons||[]).join(',')}`;
  return `<article class="card ${cls}"><div class="title">${i+1}. ${esc(x.reference_id)} · probe ${x.probe_index}</div><div class="meta">来源 ${esc(x.source_id||'control')} · ${x.duration_s.toFixed(2)}s<br>${esc(x.text)}</div><div class="scores">CAM ${x.centroid_similarity.toFixed(4)} | CER ${x.cer.toFixed(3)} | SNR ${x.snr_proxy_db.toFixed(1)}dB | RMS ${x.rms.toFixed(4)}\n${group}</div><audio controls preload="none" src="/audio/${encodeURIComponent(x.audio_file)}"></audio><div class="row"><button onclick="promote('${esc(x.reference_id)}')">用此参考音</button></div></article>`;
 }).join('');
}
async function promote(id){
 if(!confirm(`确定用 ${id} 替换 active reference？`))return;
 const r=await fetch('/api/promote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({referenceId:id})});
 const j=await r.json();alert(r.ok?`已替换：${j.referenceId}\n下一句合成即生效。`:`替换失败：${j.error}`);
}
document.querySelector('#q').oninput=render;document.querySelector('#sort').onchange=render;
fetch('/api/items').then(r=>r.json()).then(x=>{rows=x;render();}).catch(e=>document.querySelector('#app').textContent=e);
</script>"""


class Handler(BaseHTTPRequestHandler):
    rows: list[dict] = []

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        if parsed.path == "/api/items":
            body = json.dumps(self.rows, ensure_ascii=False).encode("utf-8")
            self._send(200, body, "application/json; charset=utf-8")
            return
        if parsed.path.startswith("/audio/"):
            try:
                name = Path(unquote(parsed.path.removeprefix("/audio/"))).name
                path = (PROBES / name).resolve()
                path.relative_to(PROBES.resolve())
                self._send(200, path.read_bytes(), "audio/wav")
            except (OSError, ValueError):
                self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/promote":
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            result = _promote(str(body.get("referenceId") or ""), self.rows)
            self._send(200, json.dumps(result).encode("utf-8"), "application/json")
        except Exception as error:
            body = json.dumps({"error": f"{type(error).__name__}: {error}"}).encode("utf-8")
            self._send(400, body, "application/json")

    def log_message(self, format: str, *args) -> None:
        return


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    Handler.rows = _load_rows()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"reference gallery: {url}", flush=True)
    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
