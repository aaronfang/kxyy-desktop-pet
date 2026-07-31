$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\.." )).Path
$venv = Join-Path $PSScriptRoot ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$source = Join-Path $PSScriptRoot "work\VoxCPM"
$model = Join-Path $PSScriptRoot "work\models\VoxCPM2"
New-Item -ItemType Directory -Force -Path (Split-Path $source), (Split-Path $model) | Out-Null
if (-not (Test-Path (Join-Path $source "pyproject.toml"))) {
  git clone https://github.com/OpenBMB/VoxCPM.git $source
  git -C $source checkout 616d3d3e630a9c96c2853250eef91b0f39dcd5fa
}
if (-not (Test-Path $python)) { py -3.11 -m venv $venv }
& $python -m pip install -U pip
& $python -m pip install -e $source soundfile websockets openai-whisper
if (-not (Test-Path (Join-Path $model "model.safetensors"))) {
  & $python -c "from huggingface_hub import snapshot_download; snapshot_download('openbmb/VoxCPM2', local_dir=r'$model', max_workers=1)"
}
Write-Host "VoxCPM2 runtime ready. Model directory: $model"
