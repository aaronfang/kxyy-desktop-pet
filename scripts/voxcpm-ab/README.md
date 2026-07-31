# VoxCPM2 A/B

This is an offline benchmark only. It uses the approved app-effective reference `utt_7b57586991da.wav` and its exact transcript, with VoxCPM2 Ultimate Cloning (`cfg=2.0`, `steps=10`).

For Windows, run `powershell -ExecutionPolicy Bypass -File scripts/voxcpm-ab/setup.ps1` once. On macOS, selecting `VoxCPM2（本地零样本）` automatically runs `scripts/macos/setup-voxcpm2.sh` into the writable Application Support runtime. macOS support is experimental and Apple-Silicon-only: MPS is forced to FP32 and the 4.6 GiB model is downloaded outside the app bundle. The backend uses WS `19878` and HTTP `19978`.

```powershell
& .\scripts\voxcpm-ab\.venv\Scripts\python.exe .\scripts\voxcpm-ab\generate_ab.py --mode random --streaming --run-name voxcpm2-random-stream
& .\scripts\voxcpm-ab\.venv\Scripts\python.exe .\scripts\voxcpm-ab\generate_ab.py --mode fixed --streaming --run-name voxcpm2-fixed-stream
& .\scripts\persona-distill\.venv-distill\Scripts\python.exe .\scripts\qwen3-finetune\score_voice_stability.py --input vox-random=.\scripts\voxcpm-ab\reports\voxcpm2-random-stream.jsonl --input vox-fixed=.\scripts\voxcpm-ab\reports\voxcpm2-fixed-stream.jsonl --run-name voxcpm2-score
```

Weights, audio, and reports are intentionally ignored. Do not switch the production backend based on this score alone; listen to representative files and validate realtime integration separately.
