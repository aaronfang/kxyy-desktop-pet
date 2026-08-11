#!/usr/bin/env bash
# PROTOTYPE: isolated Apple Silicon runtime for Higgs/Qwen A/B.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv-macos"
PYTHON="${KXYY_HIGGS_PYTHON:-$(command -v python3.12 || true)}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Higgs MLX test requires Apple Silicon macOS" >&2
  exit 1
fi
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.12 is required (brew install python@3.12)" >&2
  exit 1
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install -U pip wheel
"$VENV/bin/python" -m pip install \
  "git+https://github.com/Blaizzy/mlx-audio.git@41aba815e716623b4d94647c09cc88de9999e97c" \
  "mlx-whisper" "websockets>=12.0" \
  "soundfile==0.14.0" "numpy>=2.0" "torch"
"$VENV/bin/python" "$HERE/benchmark.py" doctor
echo "Ready. Benchmark: npm run prototype:higgs -- run --provider higgs-mlx --quick"
echo "Realtime: select Higgs Audio v3 in the App, then save settings"
