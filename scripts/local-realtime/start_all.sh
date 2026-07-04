#!/usr/bin/env bash
# 启动本地实时语音服务（Qwen :9876 + CosyVoice :9877）
# 使用 double-fork 守护进程，避免随终端/IDE 会话退出。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="${DIR}/../voice-ab/.venv/bin/python"
LOG_DIR="${DIR}/out"
mkdir -p "$LOG_DIR"

if [[ ! -x "$VENV" ]]; then
  echo "找不到 venv：$VENV"
  exit 1
fi

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.4
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

stop_port 9876
stop_port 9877
# 清空旧日志尾部标记
: >"$LOG_DIR/qwen.log"
: >"$LOG_DIR/cosy.log"

"$VENV" "$DIR/daemonize.py" "$LOG_DIR/qwen.log" "$VENV" "$DIR/server.py"
"$VENV" "$DIR/daemonize.py" "$LOG_DIR/cosy.log" "$VENV" "$DIR/server_cosyvoice.py"

echo "等待服务就绪…"
for i in $(seq 1 40); do
  qwen_ok=0
  cosy_ok=0
  lsof -iTCP:9876 -sTCP:LISTEN >/dev/null 2>&1 && qwen_ok=1
  lsof -iTCP:9877 -sTCP:LISTEN >/dev/null 2>&1 && cosy_ok=1
  if [[ "$qwen_ok" -eq 1 && "$cosy_ok" -eq 1 ]]; then
    echo "OK  Qwen      ws://127.0.0.1:9876"
    echo "OK  CosyVoice ws://127.0.0.1:9877"
    echo "日志：$LOG_DIR/qwen.log  $LOG_DIR/cosy.log"
    # 写 pid 方便 stop
    lsof -tiTCP:9876 -sTCP:LISTEN >"$LOG_DIR/qwen.pid" 2>/dev/null || true
    lsof -tiTCP:9877 -sTCP:LISTEN >"$LOG_DIR/cosy.pid" 2>/dev/null || true
    exit 0
  fi
  sleep 0.5
done

echo "启动超时，请查看日志："
tail -30 "$LOG_DIR/qwen.log" || true
tail -30 "$LOG_DIR/cosy.log" || true
exit 1
