# VoxCPM2 A/B

This is an offline benchmark only. It uses the approved app-effective reference `utt_7b57586991da.wav` and its exact transcript, with VoxCPM2 Ultimate Cloning (`cfg=2.0`). The generic A/B command defaults to `steps=10`; the realtime service uses 6 steps on Windows to keep measured streaming RTF below 1, while macOS retains the 10-step quality baseline.

For Windows, run `powershell -ExecutionPolicy Bypass -File scripts/voxcpm-ab/setup.ps1` once. On macOS, selecting `VoxCPM2（本地零样本）` automatically runs `scripts/macos/setup-voxcpm2.sh` into the writable Application Support runtime. macOS support is experimental and Apple-Silicon-only: MPS is forced to FP32 and the 4.6 GiB model is downloaded outside the app bundle. The backend uses WS `19878` and HTTP `19978`.

The Windows 6-step production choice was measured on an RTX 5080 with Torch 2.11.0+cu128: the same fixed short Chinese sentence improved from roughly 244ms TTFA / 1.32 RTF at 10 steps to 169ms TTFA / 0.94 RTF at 6 steps. Keep `--steps 10` for historical quality comparisons, and pass `--steps 6` when reproducing the Windows realtime profile. Do not apply the Windows step reduction to macOS without a separate device listening and RTF evaluation.

```powershell
& .\scripts\voxcpm-ab\.venv\Scripts\python.exe .\scripts\voxcpm-ab\generate_ab.py --mode random --streaming --run-name voxcpm2-random-stream
& .\scripts\voxcpm-ab\.venv\Scripts\python.exe .\scripts\voxcpm-ab\generate_ab.py --mode fixed --streaming --run-name voxcpm2-fixed-stream
& .\scripts\persona-distill\.venv-distill\Scripts\python.exe .\scripts\qwen3-finetune\score_voice_stability.py --input vox-random=.\scripts\voxcpm-ab\reports\voxcpm2-random-stream.jsonl --input vox-fixed=.\scripts\voxcpm-ab\reports\voxcpm2-fixed-stream.jsonl --run-name voxcpm2-score
```

Weights, audio, and reports are intentionally ignored. Do not switch the production backend based on this score alone; listen to representative files and validate realtime integration separately.
