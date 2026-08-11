# Higgs TTS 3 / Qwen3-TTS A/B prototype

This is local-only evaluation and experimental integration code. It answers whether Higgs TTS 3 improves YuanYuan voice cloning, expressive delivery, streaming latency/stability, and hardware coverage enough to justify a future production adapter. The app backend now includes an opt-in macOS Higgs realtime path; model files and generated reports remain local and are not shipped.

## macOS Apple Silicon

```bash
bash scripts/higgs-ab/setup-macos.sh
npm run prototype:higgs -- doctor
npm run prototype:higgs -- run --provider higgs-mlx --model bosonai/higgs-tts-3-4b --ref-profile higgs-legacy --quick
npm run prototype:higgs -- run --provider qwen-mlx --ref-profile qwen-top1 --quick
```

Remove `--quick` for the complete repeated corpus. The first Higgs run downloads about 9 GB of weights. The command uses the exact model repository from the request. The MLX loader may instead require the publisher's alias `bosonai/higgs-audio-v3-tts-4b`; only use that alias after recording its revision and comparing the model manifest. Both providers use the same allow-listed YuanYuan reference and transcript. MLX Higgs currently returns complete utterances, so its report must show `native_streaming: false`; splitting completed audio is not counted as TTFA or native streaming.

Reference audio is model-specific. Higgs defaults to `higgs-legacy` (`ref.wav`, the 15.9s legacy recording), because the shorter, quieter Qwen speaker-similarity candidates condition poorly in the current MLX port. Qwen defaults to `qwen-top1` (`utt_9627ec90ea95.wav`) to preserve the existing baseline. Pass `--ref` for a custom recording; it overrides the profile and is recorded as `custom` in `summary.json`.

## Experimental realtime call

Install the additional local-call dependencies once, then select `Higgs Audio v3（macOS 实验）` in Settings > Voice and save:

```bash
npm run prototype:higgs:setup
npm run dev
```

The App manages `server_higgs.py` on WS `19879` and HTTP `19979`. It must be launched by the App because the realtime service requires the App-managed loopback AI proxy and its internal secret. The backend reuses the existing ASR, LLM, VAD, sentence pipeline, managed PCM envelope, cancellation ledger, playback receipts, and proactive-call controls. Higgs MLX advertises `provider-pcm-v1` when its internal v3 streaming hooks are available; it uses bounded clause splitting, rolling decode, and a finite prebuffer to preserve complete, stable playback. Set `KXYY_HIGGS_STREAMING=0` only for a buffered diagnostic fallback.

The default is the Legacy 15.9s reference at temperature `0.3`. A manual reference path/text in Settings overrides it. The voice-preserving emotion policy is deliberately narrow: amusement uses emotion-only, contemplation may add `speed_slow`, and surprise emits no Higgs control token. `pitch_high` and `expressive_high` are never emitted.

## Windows RTX 4090 Laptop / RTX 5080

First validate the installed Qwen runtime and CUDA kernels:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\higgs-ab\setup-windows.ps1
```

Run SGLang-Omni in WSL2/Docker using its official Higgs cookbook. Mount the reference audio into the server and pass the path visible inside that server:

```powershell
python scripts\higgs-ab\benchmark.py run --provider higgs-sglang `
  --url http://127.0.0.1:8000 `
  --server-ref-audio /workspace/kxyy/scripts/local-realtime/assets/kxyy-yuanyuan/utt_9627ec90ea95.wav `
  --run-name higgs-rtx5080

scripts\local-realtime\.venv-qwen3\Scripts\python.exe scripts\higgs-ab\benchmark.py run `
  --provider qwen-runtime --run-name qwen-rtx5080
```

Repeat with explicit `higgs-rtx4090m` / `qwen-rtx4090m` run names. A 4090 Laptop GPU is not equivalent to a desktop 4090; keep the doctor output in each report. Many 4090 Laptop and RTX 5080 configurations have 16 GB VRAM, below the model publisher's known-good 40 GB floor and the 24 GB setup reported as working; treat an OOM at model load as an expected compatibility result, not an adapter bug. RTX 5080 must report `sm_120` in `cudaArchList` and pass the real CUDA tensor smoke before any successful result is accepted.

## Results and interpretation

Each run writes ignored artifacts under `scripts/higgs-ab/reports/<run>/`:

- `results.jsonl`: per-utterance TTFA, RTF, duration, chunk count, peak accelerator memory, and native-streaming truth.
- `summary.json`: hardware/runtime identity and aggregate latency.
- `index.html`: listening sheet for voice similarity and emotional naturalness.
- `audio/*.wav`: generated samples.

Compare two completed runs directly:

```bash
npm run prototype:higgs -- compare \
  scripts/higgs-ab/reports/higgs-mac-legacy-full/summary.json \
  scripts/higgs-ab/reports/qwen-mac-full/summary.json
```

The JSONL shape is compatible with `scripts/qwen3-finetune/score_voice_stability.py`; run the existing scorer on a CUDA machine with the project's centroid to compare speaker outliers and CER. Do not compare only averages: require minimum speaker similarity, pairwise minimum, repetition count, and representative blind listening.

Feature interpretation:

| Project requirement | Higgs MLX | Higgs SGLang | Qwen baseline |
|---|---|---|---|
| 24 kHz PCM / current playback | Direct | Direct raw PCM stream | Direct |
| Zero-shot clone with ref transcript | Yes | Yes | Yes |
| Explicit emotion/prosody | Native allow-listed inline controls | Same | Base model has no equivalent control |
| Provider-native streaming | Not exposed by current MLX API | Yes | macOS MLX / Windows faster path only when runtime reports it |
| Cancellation / generation ledger | Not tested by this generator benchmark | Network request can be cancelled, app ledger still needs adapter work | Production implementation is the baseline |

Acceptance requires successful full runs on the target Mac, RTX 4090 Laptop, and RTX 5080; fixed-corpus blind listening; no stale audio after cancellation tests in a later service adapter; and 100 consecutive generations without crashes or rising accelerator memory.
