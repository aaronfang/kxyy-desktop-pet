#!/usr/bin/env python3
"""PROTOTYPE: compare Higgs TTS 3 with the app's Qwen3-TTS baseline."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
import warnings
import wave
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CASES_PATH = HERE / "cases.json"
DEFAULT_REF = ROOT / "scripts/local-realtime/assets/kxyy-yuanyuan/utt_9627ec90ea95.wav"
LEGACY_REF = ROOT / "scripts/local-realtime/assets/kxyy-yuanyuan/ref.wav"
VOICE_CATALOG = ROOT / "scripts/local-realtime/assets/kxyy-yuanyuan/voices.json"
OUTPUT_RATE = 24_000
PCM_CHUNK_BYTES = OUTPUT_RATE * 2 * 80 // 1000


@dataclass
class Generated:
    pcm: bytes
    sample_rate: int
    ttfa_s: float
    generation_s: float
    chunks: int
    native_streaming: bool
    peak_memory_gib: float | None = None


def _run_text(command: list[str]) -> str:
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return ""


def hardware_info() -> dict:
    info = {
        "os": platform.system(),
        "osRelease": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "processor": platform.processor(),
    }
    if sys.platform == "darwin":
        raw = _run_text(["sysctl", "-n", "hw.memsize"])
        info["unifiedMemoryGiB"] = round(int(raw) / 2**30, 2) if raw.isdigit() else None
        info["macModel"] = _run_text(["sysctl", "-n", "hw.model"])
    try:
        import torch

        info["torchVersion"] = torch.__version__
        info["cudaAvailable"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info.update(
                cudaVersion=torch.version.cuda,
                cudaDevice=props.name,
                cudaCapability=f"sm_{props.major}{props.minor}",
                cudaMemoryGiB=round(props.total_memory / 2**30, 2),
                cudaArchList=list(torch.cuda.get_arch_list()),
            )
    except ImportError:
        info["torchVersion"] = None
    try:
        import mlx.core as mx

        info["mlxAvailable"] = True
        info["mlxDevice"] = str(mx.default_device())
    except ImportError:
        info["mlxAvailable"] = False
    try:
        from importlib.metadata import version

        info["mlxAudioVersion"] = version("mlx-audio")
    except Exception:
        info["mlxAudioVersion"] = None
    return info


def reference_text(path: Path) -> str:
    catalog = json.loads(VOICE_CATALOG.read_text(encoding="utf-8"))
    resolved = path.resolve()
    for item in catalog["voices"]:
        if (VOICE_CATALOG.parent / item["audio"]).resolve() == resolved:
            return str(item["text"]).strip()
    sibling = path.with_suffix(".txt")
    if sibling.is_file():
        return sibling.read_text(encoding="utf-8").strip()
    raise SystemExit("reference transcript is required; pass --ref-text")


def wav_pcm(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise RuntimeError("benchmark output must be mono PCM16 WAV")
        return source.readframes(source.getnframes()), source.getframerate()


def write_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)


def float_audio_to_pcm(audio) -> bytes:
    import numpy as np

    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not values.size or not bool(np.isfinite(values).all()):
        raise RuntimeError("empty or non-finite audio")
    return (np.clip(values, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class MlxAdapter:
    native_streaming = False

    def __init__(self, model_id: str, ref_audio: Path, ref_text: str, temperature: float = 0.8, raw_reference: bool = False) -> None:
        if sys.platform != "darwin" or platform.machine() != "arm64":
            raise RuntimeError("MLX provider requires Apple Silicon macOS")
        from mlx_audio.tts import load

        self.model_id = model_id
        load_options = {"model_type": "higgs_audio_v3"} if "higgs" in model_id.lower() else {}
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="invalid value encountered in divide",
                category=RuntimeWarning,
            )
            self.model = load(model_id, **load_options)
        self.ref_audio = ref_audio
        self.ref_text = ref_text
        self.temperature = temperature
        self.raw_reference = raw_reference
        self.ref_codes = None
        encoder = getattr(self.model, "encode_reference_audio", None)
        if callable(encoder) and not raw_reference:
            self.ref_codes = encoder(str(ref_audio))

    def generate(self, text: str) -> Generated:
        kwargs = {
            "text": text,
            "ref_text": self.ref_text,
            "temperature": self.temperature,
            "max_new_tokens": 1024,
        }
        if self.ref_codes is not None:
            kwargs["ref_audio_codes"] = self.ref_codes
        else:
            kwargs["ref_audio"] = str(self.ref_audio)
        started = time.perf_counter()
        result = next(self.model.generate(**kwargs))
        elapsed = time.perf_counter() - started
        pcm = float_audio_to_pcm(result.audio)
        sample_rate = int(getattr(result, "sample_rate", 0) or getattr(self.model, "sample_rate", 0))
        peak = None
        try:
            import mlx.core as mx

            peak = round(float(mx.get_peak_memory()) / 2**30, 3)
        except (AttributeError, TypeError):
            pass
        return Generated(pcm, sample_rate, elapsed, elapsed, 1, False, peak)


class SglangAdapter:
    native_streaming = True

    def __init__(self, url: str, model_id: str, ref_audio: str, ref_text: str) -> None:
        self.url = url.rstrip("/") + "/v1/audio/speech"
        self.model_id = model_id
        self.ref_audio = ref_audio
        self.ref_text = ref_text

    def generate(self, text: str) -> Generated:
        payload = {
            "model": self.model_id,
            "input": text,
            "references": [{"audio_path": self.ref_audio, "text": self.ref_text}],
            "temperature": 0.8,
            "top_k": 50,
            "max_new_tokens": 1024,
            "stream": True,
            "response_format": "pcm",
        }
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        started = time.perf_counter()
        chunks: list[bytes] = []
        first = None
        with urllib.request.urlopen(request, timeout=300) as response:
            sample_rate = int(response.headers.get("x-audio-sample-rate", OUTPUT_RATE))
            while True:
                chunk = response.read(PCM_CHUNK_BYTES)
                if not chunk:
                    break
                if first is None:
                    first = time.perf_counter() - started
                chunks.append(chunk)
        elapsed = time.perf_counter() - started
        return Generated(b"".join(chunks), sample_rate, first or elapsed, elapsed, len(chunks), True)


class QwenRuntimeAdapter:
    native_streaming = True

    def __init__(self) -> None:
        from concurrent.futures import ThreadPoolExecutor

        sys.path.insert(0, str(ROOT / "scripts/local-realtime"))
        import tts_qwen3_torch

        self.qwen = tts_qwen3_torch
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="higgs-ab-qwen")
        self.qwen.configure_from_settings(self.pool)

    def generate(self, text: str) -> Generated:
        async def collect() -> tuple[bytes, float, int]:
            started = time.perf_counter()
            chunks = []
            first = None
            async for event in self.qwen.synth_tts_stream(text):
                if event.get("type") != "audio":
                    continue
                if first is None:
                    first = time.perf_counter() - started
                chunks.append(event["pcm"])
            return b"".join(chunks), first or time.perf_counter() - started, len(chunks)

        started = time.perf_counter()
        if self.qwen.streaming_supported():
            pcm, ttfa, chunks = asyncio.run(collect())
            native = True
        else:
            pcm = self.qwen.synth_tts(text)
            ttfa = time.perf_counter() - started
            chunks = 1
            native = False
        elapsed = time.perf_counter() - started
        peak = None
        try:
            import torch

            if torch.cuda.is_available():
                peak = round(torch.cuda.max_memory_allocated() / 2**30, 3)
        except ImportError:
            pass
        return Generated(pcm, OUTPUT_RATE, ttfa, elapsed, chunks, native, peak)


def adapter_for(args, ref_audio: Path, ref_text_value: str):
    if args.provider in ("higgs-mlx", "qwen-mlx"):
        return MlxAdapter(args.model, ref_audio, ref_text_value, args.temperature, args.raw_reference)
    if args.provider == "higgs-sglang":
        server_ref = args.server_ref_audio or str(ref_audio.resolve())
        return SglangAdapter(args.url, args.model, server_ref, ref_text_value)
    if args.provider == "qwen-runtime":
        return QwenRuntimeAdapter()
    raise AssertionError(args.provider)


def model_default(provider: str) -> str:
    if provider == "higgs-mlx":
        return "bosonai/higgs-tts-3-4b"
    if provider == "higgs-sglang":
        return "bosonai/higgs-audio-v3-tts-4b"
    return "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"


def resolve_reference(args) -> tuple[Path, str]:
    profiles = {
        "higgs-legacy": LEGACY_REF,
        "qwen-top1": DEFAULT_REF,
    }
    if args.ref is not None:
        return args.ref.resolve(), "custom"
    profile = args.ref_profile or ("higgs-legacy" if args.provider.startswith("higgs") else "qwen-top1")
    try:
        return profiles[profile].resolve(), profile
    except KeyError as error:
        raise SystemExit(f"unknown reference profile: {profile}") from error


def run_benchmark(args) -> int:
    ref_audio, ref_profile = resolve_reference(args)
    ref_text_value = args.ref_text or reference_text(ref_audio)
    if not ref_audio.is_file():
        raise SystemExit(f"missing reference audio: {ref_audio}")
    args.model = args.model or model_default(args.provider)
    adapter = adapter_for(args, ref_audio, ref_text_value)
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
    if args.suite != "all":
        cases = [case for case in cases if case["suite"] == args.suite]
    if args.quick:
        seen = set()
        cases = [case for case in cases if not (case["suite"] in seen or seen.add(case["suite"]))]
    run_name = args.run_name or f"{args.provider}-{time.strftime('%Y%m%d-%H%M%S')}"
    output = HERE / "reports" / run_name
    audio_dir = output / "audio"
    output.mkdir(parents=True, exist_ok=True)
    machine = hardware_info()
    rows = []
    for case in cases:
        repeats = 1 if args.quick else int(case.get("repeats", 1))
        for repeat in range(1, repeats + 1):
            item_id = f"{case['id']}-r{repeat:02d}"
            spoken = case["text"]
            if args.provider.startswith("higgs"):
                spoken = str(case.get("higgsPrefix", "")) + spoken
            row = {
                "schema_version": 1,
                "id": item_id,
                "prompt_id": case["id"],
                "suite": case["suite"],
                "repeat": repeat,
                "provider": args.provider,
                "model": args.model,
                "text": case["text"],
                "control": case.get("higgsPrefix", "") if args.provider.startswith("higgs") else "",
                "streaming_requested": args.provider in ("higgs-sglang", "qwen-runtime"),
            }
            print(f"[{len(rows) + 1}] {item_id}", flush=True)
            try:
                result = adapter.generate(spoken)
                if not result.pcm or result.sample_rate <= 0:
                    raise RuntimeError("provider returned no audio")
                path = audio_dir / f"{item_id}.wav"
                write_wav(path, result.pcm, result.sample_rate)
                duration = len(result.pcm) / 2 / result.sample_rate
                row.update(
                    status="ok",
                    audio=str(path.resolve()),
                    sample_rate=result.sample_rate,
                    duration_s=round(duration, 3),
                    generation_s=round(result.generation_s, 3),
                    ttfa_s=round(result.ttfa_s, 3),
                    rtf=round(result.generation_s / max(duration, 0.001), 3),
                    chunks=result.chunks,
                    native_streaming=result.native_streaming,
                    peak_memory_gib=result.peak_memory_gib,
                )
            except Exception as error:
                row.update(status="failed", error_type=type(error).__name__, error=str(error)[:300])
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    jsonl = output / "results.jsonl"
    jsonl.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    ok = [row for row in rows if row["status"] == "ok"]
    summary = {
        "schemaVersion": 1,
        "run": run_name,
        "provider": args.provider,
        "model": args.model,
        "referenceAudio": str(ref_audio),
        "referenceProfile": ref_profile,
        "hardware": machine,
        "count": len(rows),
        "successCount": len(ok),
        "nativeStreamingCount": sum(bool(row.get("native_streaming")) for row in ok),
        "meanTtfaS": round(sum(row["ttfa_s"] for row in ok) / len(ok), 3) if ok else None,
        "meanRtf": round(sum(row["rtf"] for row in ok) / len(ok), 3) if ok else None,
        "peakMemoryGiB": max((row.get("peak_memory_gib") or 0 for row in ok), default=0),
        "featureCompatibility": {
            "pcm24k": "pass" if all(row.get("sample_rate") == OUTPUT_RATE for row in ok) and ok else "not-tested",
            "referenceTranscriptClone": "pass" if ok else "not-tested",
            "emotionControls": "native" if args.provider.startswith("higgs") else "baseline-not-supported",
            "nativeStreaming": "pass" if any(row.get("native_streaming") for row in ok) else "not-exposed",
            "appCancellationLedger": "not-tested-by-generator",
            "staleAudioAfterCancellation": "requires-service-adapter-test",
        },
    }
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    build_report(output, rows, summary)
    print(f"report: {output / 'index.html'}")
    return 0 if len(ok) == len(rows) else 1


def build_report(output: Path, rows: list[dict], summary: dict) -> None:
    cards = []
    for row in rows:
        audio = ""
        if row.get("status") == "ok":
            rel = Path(row["audio"]).relative_to(output)
            audio = f'<audio controls preload="none" src="{rel.as_posix()}"></audio>'
        metrics = (
            f"TTFA {row.get('ttfa_s', '-')}s | RTF {row.get('rtf', '-')} | "
            f"chunks {row.get('chunks', '-')} | native stream {row.get('native_streaming', False)}"
        )
        cards.append(
            f'<section><h2>{row["id"]}</h2><p>{row["text"]}</p><small>{metrics}</small>{audio}'
            '<p>音色相似度 <input type="range" min="1" max="5"> 情绪自然度 <input type="range" min="1" max="5"></p></section>'
        )
    html = f"""<!doctype html><meta charset="utf-8"><title>{summary['run']}</title>
<style>body{{font:15px system-ui;max-width:960px;margin:32px auto;padding:0 16px}}section{{border-top:1px solid #ccc;padding:14px 0}}audio{{display:block;width:100%;margin:10px 0}}small{{color:#555}}</style>
<h1>{summary['run']}</h1><pre>{json.dumps(summary, ensure_ascii=False, indent=2)}</pre>{''.join(cards)}"""
    (output / "index.html").write_text(html, encoding="utf-8")


def doctor() -> int:
    state = hardware_info()
    state["referenceAudioExists"] = DEFAULT_REF.is_file()
    state["casesSchema"] = json.loads(CASES_PATH.read_text(encoding="utf-8"))["schemaVersion"]
    print(json.dumps(state, ensure_ascii=False, indent=2))
    if sys.platform == "darwin" and platform.machine() != "arm64":
        return 1
    return 0


def compare(args) -> int:
    left_path, right_path = Path(args.left).resolve(), Path(args.right).resolve()
    left = json.loads(left_path.read_text(encoding="utf-8"))
    right = json.loads(right_path.read_text(encoding="utf-8"))
    fields = ("successCount", "count", "meanTtfaS", "meanRtf", "peakMemoryGiB")
    result = {
        "left": left.get("run", args.left),
        "right": right.get("run", args.right),
        "metrics": {
            field: {"left": left.get(field), "right": right.get(field)}
            for field in fields
        },
        "featureCompatibility": {
            "left": left.get("featureCompatibility", {}),
            "right": right.get("featureCompatibility", {}),
        },
    }
    for field in ("meanTtfaS", "meanRtf", "peakMemoryGiB"):
        lvalue, rvalue = left.get(field), right.get(field)
        if isinstance(lvalue, (int, float)) and isinstance(rvalue, (int, float)) and lvalue:
            result["metrics"][field]["rightVsLeft"] = round((rvalue - lvalue) / lvalue, 3)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    output = Path(args.output).resolve() if args.output else HERE / "reports" / f"compare-{left['run']}-vs-{right['run']}.html"
    left_rows = {
        row["id"]: row
        for row in _read_jsonl(left_path.with_name("results.jsonl"))
    }
    right_rows = {
        row["id"]: row
        for row in _read_jsonl(right_path.with_name("results.jsonl"))
    }
    sections = []
    for item_id in sorted(set(left_rows) & set(right_rows)):
        lrow, rrow = left_rows[item_id], right_rows[item_id]
        laudio = os.path.relpath(lrow["audio"], output.parent)
        raudio = os.path.relpath(rrow["audio"], output.parent)
        sections.append(f"""<section><h2>{item_id}</h2><p>{lrow['text']}</p>
<div class="pair"><article><h3>{left['provider']}</h3><small>TTFA {lrow['ttfa_s']}s | RTF {lrow['rtf']}</small><audio controls preload="none" src="{laudio}"></audio></article>
<article><h3>{right['provider']}</h3><small>TTFA {rrow['ttfa_s']}s | RTF {rrow['rtf']}</small><audio controls preload="none" src="{raudio}"></audio></article></div>
<p>更像元元：<label><input type="radio" name="voice-{item_id}">左</label> <label><input type="radio" name="voice-{item_id}">右</label> <label><input type="radio" name="voice-{item_id}">接近</label>　情绪自然度 <input type="range" min="1" max="5"></p></section>""")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(f"""<!doctype html><meta charset="utf-8"><title>{result['left']} vs {result['right']}</title>
<style>body{{font:15px system-ui;max-width:1080px;margin:32px auto;padding:0 16px}}section{{border-top:1px solid #ccc;padding:14px 0}}.pair{{display:grid;grid-template-columns:1fr 1fr;gap:24px}}audio{{display:block;width:100%;margin:10px 0}}small{{color:#555}}@media(max-width:700px){{.pair{{grid-template-columns:1fr}}}}</style>
<h1>{result['left']} vs {result['right']}</h1><pre>{json.dumps(result, ensure_ascii=False, indent=2)}</pre>{''.join(sections)}""", encoding="utf-8")
    print(f"listeningReport: {output}")
    return 0


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="PROTOTYPE Higgs/Qwen local TTS A/B")
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    comparison = sub.add_parser("compare")
    comparison.add_argument("left", help="left summary.json")
    comparison.add_argument("right", help="right summary.json")
    comparison.add_argument("--output", help="side-by-side listening HTML")
    run = sub.add_parser("run")
    run.add_argument("--provider", choices=("higgs-mlx", "qwen-mlx", "higgs-sglang", "qwen-runtime"), required=True)
    run.add_argument("--model")
    run.add_argument("--suite", choices=("all", "clone", "emotion", "compatibility", "streaming", "stability"), default="all")
    run.add_argument("--quick", action="store_true")
    run.add_argument("--run-name")
    run.add_argument("--ref", type=Path, help="custom reference audio; overrides --ref-profile")
    run.add_argument("--ref-profile", choices=("higgs-legacy", "qwen-top1"), help="model-specific bundled reference preset")
    run.add_argument("--ref-text")
    run.add_argument("--url", default="http://127.0.0.1:8000")
    run.add_argument("--server-ref-audio", help="reference path as seen by the SGLang container/server")
    run.add_argument("--temperature", type=float, default=0.8)
    run.add_argument("--raw-reference", action="store_true", help="do not pre-encode MLX reference audio")
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "doctor":
        return doctor()
    if args.command == "compare":
        return compare(args)
    return run_benchmark(args)


if __name__ == "__main__":
    raise SystemExit(main())
