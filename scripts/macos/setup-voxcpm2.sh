#!/usr/bin/env bash
# macOS Apple Silicon VoxCPM2 runtime. Runtime and model stay in Application Support.
set -euo pipefail
export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
# Hugging Face's Xet transport can stall indefinitely on some macOS networks.
# Prefer the resumable standard HTTP path unless the caller explicitly opts in.
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "[setup-voxcpm] 错误：VoxCPM2 macOS 后端要求 Apple Silicon（arm64），Intel 不支持实时运行。"; exit 1
fi
RUNTIME="${KXYY_VOXCPM_RUNTIME:-$HOME/Library/Application Support/com.aaronfang.kxyydesktoppet/voice-runtime}"
RESOURCES="${KXYY_VOXCPM_RESOURCES:-$(cd "$(dirname "$0")/../.." && pwd)}"
VENV="$RUNTIME/.venv-voxcpm2"; MODEL="$RUNTIME/voxcpm2-model"; MARKER="$RUNTIME/.voxcpm2-ready"
SOURCE_COMMIT="616d3d3e630a9c96c2853250eef91b0f39dcd5fa"
log(){ echo "[setup-voxcpm] $*"; }
if [[ -f "$MARKER" && -x "$VENV/bin/python" && -d "$MODEL" && "${1:-}" != "--force" ]]; then log "已配置，跳过"; exit 0; fi
mkdir -p "$RUNTIME"
PY_SYS=""
for candidate in python3.11 python3.10 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10; do
  if command -v "$candidate" >/dev/null 2>&1; then PY_SYS="$(command -v "$candidate")"; break; fi
done
[[ -n "$PY_SYS" ]] || { log "错误：未找到受支持的 Python 3.10/3.11，请先安装其中一个版本。"; exit 1; }
log "STEP 1/5 创建独立运行时：$VENV"
[[ -x "$VENV/bin/python" ]] || "$PY_SYS" -m venv "$VENV"
PY="$VENV/bin/python"
log "STEP 2/5 安装 VoxCPM2（固定源码提交）"
"$PY" -m pip install -U pip wheel
"$PY" -m pip install "git+https://github.com/OpenBMB/VoxCPM.git@$SOURCE_COMMIT" websockets openai-whisper soundfile numpy
log "STEP 3/5 下载 openbmb/VoxCPM2（约 4.6 GiB）"
"$PY" - <<PYCODE
from huggingface_hub import snapshot_download
snapshot_download("openbmb/VoxCPM2", local_dir=r"$MODEL", max_workers=1)
PYCODE
log "STEP 4/5 验证 MPS 与模型加载"
"$PY" - <<PYCODE
import torch
if not torch.backends.mps.is_available(): raise SystemExit("MPS 不可用，请确认 Apple Silicon 与 macOS 驱动")
x=torch.ones((8,8), device="mps"); _=x @ x
from voxcpm import VoxCPM
from pathlib import Path
model = VoxCPM.from_pretrained(r"$MODEL", load_denoiser=False, local_files_only=True, device="mps")
refs = list(Path(r"$RESOURCES/scripts/local-realtime/assets").glob("*/ref.wav"))
if not refs: raise SystemExit("找不到参考音频，无法完成 VoxCPM2 生成 smoke")
audio = model.generate(text="你好。", prompt_wav_path=str(refs[0]), prompt_text="你好。", cfg_value=2.0, inference_timesteps=10, seed=424242)
import numpy as np
values = np.asarray(audio, dtype=np.float32).reshape(-1)
if values.size == 0 or not np.isfinite(values).all(): raise SystemExit("VoxCPM2 MPS 生成 smoke 输出无效")
print(f"[setup-voxcpm] 生成 smoke 成功：{values.size} samples @ 48000Hz", flush=True)
print("[setup-voxcpm] MPS FP32 模型加载成功", flush=True)
PYCODE
log "STEP 5/5 写入完成标记"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER"
log "DONE 配置完成"
