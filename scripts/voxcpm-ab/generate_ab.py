#!/usr/bin/env python3
"""Generate a bounded VoxCPM2 zero-shot A/B corpus."""
from __future__ import annotations

import argparse, json, time
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
from voxcpm import VoxCPM

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "scripts/qwen3-finetune/work/candidates/utt_7b57586991da.wav"
PROMPT = "目前没疼，就目前它只会有一点生长的痛，但是没有说就是发炎什么的，没有怎么是细的刮的呀我没毛"
TEXTS = [
    ("eval_01", "大家下午好呀，今天过得怎么样？"),
    ("eval_02", "等一下，我先把这个事情讲清楚，你们别着急。"),
    ("eval_03", "真的假的？你刚才说的那个地方，我好像也去过。"),
    ("eval_04", "欢迎新来的朋友，喜欢的话可以点个关注，谢谢大家。"),
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("random", "fixed"), required=True)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--steps", type=int, default=10)
    ap.add_argument("--streaming", action="store_true")
    ap.add_argument("--run-name", required=True)
    args = ap.parse_args()
    if not REF.is_file(): raise SystemExit(f"missing approved reference: {REF}")
    out = Path(__file__).resolve().parent / "reports/audio" / args.run_name
    meta = Path(__file__).resolve().parent / "reports" / f"{args.run_name}.jsonl"
    out.mkdir(parents=True, exist_ok=True)
    model_dir = Path(__file__).resolve().parent / "work/models/VoxCPM2"
    model = VoxCPM.from_pretrained(str(model_dir), load_denoiser=False, local_files_only=True)
    rows = []
    base_seed = 20260731
    for prompt_id, text in TEXTS:
        for repeat in range(1, args.repeats + 1):
            seed = 424242 if args.mode == "fixed" else base_seed + len(rows)
            item_id = f"{prompt_id}-r{repeat:02d}"
            audio_path = out / f"{item_id}.wav"
            started = time.perf_counter()
            try:
                kw = dict(text=text, prompt_wav_path=str(REF), prompt_text=PROMPT,
                          reference_wav_path=str(REF), cfg_value=2.0,
                          inference_timesteps=args.steps, seed=seed)
                first = None; chunks = []
                if args.streaming:
                    for chunk in model.generate_streaming(**kw):
                        if first is None: first = time.perf_counter() - started
                        chunks.append(np.asarray(chunk, dtype=np.float32))
                    wav = np.concatenate(chunks) if chunks else np.empty(0, np.float32)
                else:
                    wav = np.asarray(model.generate(**kw), dtype=np.float32)
                    first = time.perf_counter() - started
                if wav.size == 0 or not np.isfinite(wav).all(): raise ValueError("empty_or_nonfinite_audio")
                sf.write(audio_path, wav, model.tts_model.sample_rate)
                elapsed = time.perf_counter() - started
                row = dict(id=item_id, prompt_id=prompt_id, repeat=repeat, text=text,
                           audio=str(audio_path.resolve()), mode="clone", model=str(model_dir.resolve()),
                           seed=seed, status="ok", sample_rate=model.tts_model.sample_rate,
                           duration_s=round(wav.size / model.tts_model.sample_rate, 3),
                           generation_s=round(elapsed, 3), ttfa_s=round(first or elapsed, 3),
                           streaming=args.streaming, chunks=len(chunks),
                           peak_vram_gib=round(torch.cuda.max_memory_allocated() / 1e9, 3))
            except Exception as exc:
                row = dict(id=item_id, prompt_id=prompt_id, repeat=repeat, text=text,
                           audio=str(audio_path.resolve()), mode="clone", model=str(model_dir.resolve()),
                           seed=seed, status="failed", error_type=type(exc).__name__)
            rows.append(row); print(json.dumps(row, ensure_ascii=False), flush=True)
    meta.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    return 0
if __name__ == "__main__": raise SystemExit(main())
