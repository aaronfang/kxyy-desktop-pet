# Windows: set up the local Qwen3-TTS (PyTorch) voice backend.
#
# Creates an isolated venv at scripts/local-realtime/.venv-qwen3 and installs
# torch + qwen-tts + the desktop-pet voice-service deps. Run:
#   powershell -ExecutionPolicy Bypass -File scripts/windows/setup-qwen3-tts.ps1
#
# Notes:
# - This file is intentionally ASCII-only so it parses correctly under any
#   Windows codepage (PS 5.1 reads BOM-less files as ANSI/GBK on zh-CN).
# - $ErrorActionPreference stays default (Continue): pip/git write [notice]/
#   warnings to stderr, which would abort the script if set to Stop under PS 5.1.
#   Critical calls use Start-Process or explicit $LASTEXITCODE checks.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "scripts\local-realtime"))) {
  # Installed layout: this script sits in $INSTDIR\scripts\windows
  $Root = Split-Path -Parent $PSScriptRoot
}
$Lr = Join-Path $Root "scripts\local-realtime"
$Venv = Join-Path $Lr ".venv-qwen3"
$VenvPy = Join-Path $Venv "Scripts\python.exe"

Write-Host ""
Write-Host "=== KXYY Desktop Pet - local Qwen3-TTS (PyTorch) setup ===" -ForegroundColor Cyan
Write-Host "local-realtime: $Lr"
Write-Host "venv:           $Venv"
Write-Host ""

# Locate a usable Python 3.10-3.13 interpreter.
# - Skip 3.14+ : torch / qwen-tts wheels are not published yet (ResolutionImpossible).
# - Skip the "WindowsApps" App Execution Alias stub (0-byte, launches Store).
function Test-UsablePython($exe) {
  if (-not $exe) { return $false }
  $s = "$exe"
  if ($s -match 'WindowsApps') { return $false }
  try {
    $v = & $exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
  } catch { return $false }
  if (-not $v) { return $false }
  try {
    $maj, $min = $v.Split('.')
    $ver = [int]$maj * 100 + [int]$min
  } catch { return $false }
  return ($ver -ge 310 -and $ver -le 313)
}

function Find-Python {
  # Prefer explicit minor versions (3.12 > 3.11 > 3.13) over bare `python`,
  # because bare `python` may point at 3.14 (too new for torch wheels).
  foreach ($c in @('python3.12','python3.11','python3.13','python3.10','py','python','python3')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    # `py` is the launcher: ask it for a 3.10-3.13 install explicitly.
    if ($c -eq 'py') {
      foreach ($pv in @('-3.12','-3.11','-3.13','-3.10')) {
        $resolved = & $cmd.Source $pv -c "import sys,os;print(sys.executable)" 2>$null
        if ($resolved -and (Test-UsablePython $resolved)) { return $resolved }
      }
      continue
    }
    if (Test-UsablePython $cmd.Source) { return $cmd.Source }
  }
  return $null
}

$py = Find-Python
if (-not $py) {
  Write-Host "Python not found. Install Python 3.10+ from https://www.python.org/downloads/windows/ (check 'Add to PATH')." -ForegroundColor Red
  Write-Host "Press Enter to close..."
  [void][System.Console]::ReadLine()
  exit 1
}
Write-Host "Using Python: $py"

# Create venv if missing.
if (-not (Test-Path $VenvPy)) {
  Write-Host "Creating venv..." -ForegroundColor Yellow
  $p = Start-Process -FilePath $py -ArgumentList @('-m','venv',"$Venv") -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0 -or -not (Test-Path $VenvPy)) {
    Write-Host "Failed to create venv (exit=$($p.ExitCode))." -ForegroundColor Red
    Write-Host "Press Enter to close..."; [void][System.Console]::ReadLine(); exit 1
  }
} else {
  Write-Host "venv already exists: $Venv"
}

function Pip {
  param([string[]]$PipArgs, [string]$Label)
  Write-Host ">> pip $($PipArgs -join ' ')" -ForegroundColor DarkGray
  $log = Join-Path $env:TEMP ("kxyy-qwen3-pip-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".log")
  $proc = Start-Process -FilePath $VenvPy -ArgumentList (@('-m','pip') + $PipArgs) -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if ($proc.ExitCode -ne 0) {
    Write-Host "pip failed ($Label, exit=$($proc.ExitCode)). Last lines:" -ForegroundColor Red
    if (Test-Path "$log.err") { Get-Content "$log.err" -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed } }
    if (Test-Path $log)       { Get-Content $log      -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
  }
  Remove-Item $log,"$log.err" -ErrorAction SilentlyContinue
  return $proc.ExitCode
}

Write-Host ""
Write-Host "Upgrading pip..." -ForegroundColor Yellow
[void](Pip @('install','--upgrade','--disable-pip-version-check','pip','setuptools','wheel') 'pip')

# ---- PyTorch ----
# RTX 50 series (Blackwell, sm_120) need cu128 wheels — cu124/cu126 stable builds
# ship kernels only up to sm_90 and will emit "no kernel image available for
# execution on the device" (torch.cuda works but kernels fall back / fail).
# cu128 is the first stable index shipping sm_120 kernels.
function Test-Blackwell {
  try {
    $line = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null)
  } catch { return $false }
  if (-not $line) { return $false }
  return ($line -match 'RTX 50\d\d|RTX 60\d\d|Blackwell|H100|H200|B200|GB202|GB203')
}

Write-Host ""
Write-Host "PyTorch install:" -ForegroundColor Yellow
$index = $null
if (Test-Blackwell) {
  Write-Host "Detected Blackwell-class GPU; using cu128 wheels (sm_120 kernels)." -ForegroundColor Green
  $index = 'https://download.pytorch.org/whl/cu128'
} else {
  Write-Host "  [1] NVIDIA GPU (CUDA 12.4 wheels)"
  Write-Host "  [2] CPU only (works everywhere, but Qwen3-TTS is much slower on CPU)"
  $torchChoice = Read-Host "Choose [1/2] (default 1)"
  if ($torchChoice -eq '2') {
    $rc = Pip @('install','torch','torchaudio') 'torch-cpu'
  } else {
    $index = 'https://download.pytorch.org/whl/cu124'
  }
}
if ($index) {
  $rc = Pip @('install','torch','torchaudio','--index-url',$index) 'torch-cuda'
  if ($rc -ne 0) {
    Write-Host "CUDA wheel install failed; falling back to default index." -ForegroundColor Yellow
    $rc = Pip @('install','torch','torchaudio') 'torch-default'
  }
}

# ---- Qwen3-TTS + voice-service deps ----
Write-Host ""
Write-Host "Installing qwen-tts and voice-service deps..." -ForegroundColor Yellow
[void](Pip @('install','-U','qwen-tts','soundfile','numpy','websockets','certifi') 'qwen-tts')

# openai-whisper is only needed for real-time call ASR; optional.
$asr = Read-Host "Also install openai-whisper for real-time voice call ASR? [Y/n]"
if ($asr -eq '' -or $asr -match '^[Yy]') {
  [void](Pip @('install','-U','openai-whisper') 'whisper')
}

# ---- Verify ----
Write-Host ""
Write-Host "Verifying qwen_tts import..." -ForegroundColor Yellow
$check = Join-Path $env:TEMP "kxyy-qwen3-check.log"
$vp = Start-Process -FilePath $VenvPy -ArgumentList @('-c','import torch, qwen_tts; print("torch", torch.__version__, "cuda", torch.cuda.is_available())') `
  -Wait -PassThru -NoNewWindow -RedirectStandardOutput $check -RedirectStandardError "$check.err"
if ($vp.ExitCode -eq 0) {
  Get-Content $check -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
  Write-Host "OK. Qwen3-TTS PyTorch backend is ready." -ForegroundColor Green
  Write-Host "The 1.7B model (Qwen/Qwen3-TTS-12Hz-1.7B-Base) downloads on first use (several GB)." -ForegroundColor Green
} else {
  Write-Host "Import check failed. Last lines:" -ForegroundColor Red
  if (Test-Path "$check.err") { Get-Content "$check.err" -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed } }
}
Remove-Item $check,"$check.err" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Next: in the pet Settings, pick voice backend = local Qwen3-TTS, add a 10-20s reference clip, then save to start the service." -ForegroundColor Cyan
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
