#!/usr/bin/env bash
# macOS：自动配置本地 Qwen3-TTS 运行时（venv + 依赖 + 预热模型）。
# 由桌宠在首次选择「本地 Qwen3-TTS」时调用；也可手动执行。
# 输出行以 [setup-qwen3] 开头，桌宠会流式显示到设置页。
#
# 环境变量：
#   KXYY_VOICE_RUNTIME   可写运行时目录（默认 Application Support/.../voice-runtime）
#   KXYY_VOICE_RESOURCES 含 scripts/local-realtime 的资源根（.app Resources 或仓库根）

set -euo pipefail

# 无缓冲，便于设置页实时看到进度
export PYTHONUNBUFFERED=1
export PYTHONIOENCODING=utf-8

RUNTIME="${KXYY_VOICE_RUNTIME:-$HOME/Library/Application Support/com.aaronfang.kxyydesktoppet/voice-runtime}"
RESOURCES="${KXYY_VOICE_RESOURCES:-}"

if [[ -z "$RESOURCES" ]]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$HERE/../local-realtime/requirements-macos.txt" ]]; then
    RESOURCES="$(cd "$HERE/../.." && pwd)"
  elif [[ -f "$HERE/../../scripts/local-realtime/requirements-macos.txt" ]]; then
    RESOURCES="$(cd "$HERE/../.." && pwd)"
  fi
fi

LR="$RESOURCES/scripts/local-realtime"
REQ="$LR/requirements-macos.txt"
MARKER="$RUNTIME/.qwen3-ready"

log() { echo "[setup-qwen3] $*" ; }

log "STEP 0/5 准备中…"
log "runtime=$RUNTIME"
log "resources=$RESOURCES"

if [[ ! -f "$REQ" ]]; then
  log "错误：缺少 $REQ"
  exit 1
fi

if [[ -f "$MARKER" && -x "$RUNTIME/.venv/bin/python" && "${1:-}" != "--force" ]]; then
  log "已配置，跳过（$MARKER）"
  exit 0
fi

mkdir -p "$RUNTIME/out"

log "STEP 1/5 复制参考音…"
if [[ -f "$LR/assets/yuanyuan_ref_15s.wav" ]]; then
  cp -f "$LR/assets/yuanyuan_ref_15s.wav" "$RUNTIME/out/yuanyuan_ref_15s.wav"
  log "已复制 yuanyuan_ref_15s.wav"
else
  log "警告：打包内无参考音，稍后若缺失需自行提供"
fi
if [[ -f "$LR/assets/yuanyuan_ref_15s.txt" ]]; then
  cp -f "$LR/assets/yuanyuan_ref_15s.txt" "$RUNTIME/out/yuanyuan_ref_15s.txt"
fi

PY_SYS="$(command -v python3 || true)"
if [[ -z "$PY_SYS" ]]; then
  log "错误：未找到 python3，请先安装 Python 3.10+（Apple Silicon）"
  exit 1
fi
log "系统 Python：$PY_SYS"

log "STEP 2/5 创建虚拟环境（约数秒）…"
"$PY_SYS" -m venv "$RUNTIME/.venv"
# shellcheck disable=SC1091
source "$RUNTIME/.venv/bin/activate"
log "venv 已创建：$RUNTIME/.venv"

log "STEP 3/5 安装 Python 依赖（约 1–5 分钟，请稍候）…"
python -m pip install -U pip wheel
# 用默认进度；行缓冲由 PYTHONUNBUFFERED 保证
pip install -r "$REQ"
log "依赖安装完成"

log "STEP 4/5 下载 Qwen3-TTS 模型（体积较大，首次可能需数分钟到十几分钟）…"
export KXYY_VOICE_RUNTIME="$RUNTIME"
python - <<'PY'
import os
import sys
import threading
import time
from pathlib import Path

def heartbeat(label: str, stop: threading.Event) -> None:
    t0 = time.time()
    while not stop.wait(8.0):
        elapsed = int(time.time() - t0)
        print(
            f"[setup-qwen3] …仍在{label}，已等待 {elapsed}s（首次下载模型较慢，请保持网络畅通）",
            flush=True,
        )

runtime = Path(os.environ["KXYY_VOICE_RUNTIME"])
ref = runtime / "out" / "yuanyuan_ref_15s.wav"
print(f"[setup-qwen3] 参考音：{ref} exists={ref.exists()}", flush=True)

stop = threading.Event()
t = threading.Thread(
    target=heartbeat, args=("下载/加载 Qwen3-TTS", stop), daemon=True
)
t.start()
print("[setup-qwen3] 开始加载 mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit …", flush=True)
try:
    from mlx_audio.tts.utils import load_model

    load_model("mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit")
finally:
    stop.set()
print("[setup-qwen3] Qwen3-TTS 模型就绪", flush=True)
PY

log "STEP 5/5 下载 Whisper 模型（首次也可能较久）…"
python - <<'PY'
import os
import tempfile
import threading
import time
import wave
from pathlib import Path

def heartbeat(label: str, stop: threading.Event) -> None:
    t0 = time.time()
    while not stop.wait(8.0):
        elapsed = int(time.time() - t0)
        print(
            f"[setup-qwen3] …仍在{label}，已等待 {elapsed}s",
            flush=True,
        )

stop = threading.Event()
t = threading.Thread(
    target=heartbeat, args=("下载/加载 Whisper", stop), daemon=True
)
t.start()
print("[setup-qwen3] 开始加载 mlx-community/whisper-large-v3-turbo …", flush=True)
try:
    import mlx_whisper

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    path = Path(path)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000)
    try:
        mlx_whisper.transcribe(
            str(path),
            path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
            language="zh",
            verbose=False,
        )
    finally:
        path.unlink(missing_ok=True)
finally:
    stop.set()
print("[setup-qwen3] Whisper 模型就绪", flush=True)
PY

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER"
log "DONE 配置完成（$MARKER）"
