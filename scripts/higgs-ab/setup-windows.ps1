$ErrorActionPreference = "Stop"
# PROTOTYPE: hardware preflight. Higgs itself is served by SGLang-Omni/WSL2 or Docker.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\.." )).Path
$qwenPython = Join-Path $root "scripts\local-realtime\.venv-qwen3\Scripts\python.exe"

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  throw "nvidia-smi not found; install/repair the NVIDIA driver first"
}
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
if (Test-Path $qwenPython) {
  & $qwenPython $PSScriptRoot\benchmark.py doctor
  & $qwenPython -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_arch_list()); x=torch.ones(1024,device='cuda'); print(float((x*x).sum()))"
} else {
  Write-Warning "Qwen runtime is missing. Run scripts\windows\setup-qwen3-tts.ps1 for the baseline."
}
Write-Host "Start SGLang-Omni separately, then run benchmark.py with --provider higgs-sglang."
