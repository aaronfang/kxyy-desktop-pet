# ============================================================================
# 元元人设蒸馏管道 - Windows 一键安装脚本
# ============================================================================
# 用法: powershell -ExecutionPolicy Bypass -File setup.ps1
# ============================================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".venv-distill"
$VenvPy = Join-Path $Venv "Scripts\python.exe"

Write-Host ""
Write-Host "=== KXYY Desktop Pet - Persona Distillation Setup ===" -ForegroundColor Cyan
Write-Host "root: $Root"
Write-Host "venv: $Venv"
Write-Host ""

# ------------------------------------------------------------------
# 1. 查找可用 Python
# ------------------------------------------------------------------
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
    $candidates = @(
        "$env:LOCALAPPDATA\..\..\roaming\python\python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "C:\Python311\python.exe",
        "python3.11",
        "python3"
    )
    # also check the known path from memory
    $known = "C:\Users\aaronfang\.local\bin\python3.11.exe"
    if (Test-Path $known) {
        $candidates = @($known) + $candidates
    }
    foreach ($c in $candidates) {
        $found = (Get-Command $c -ErrorAction SilentlyContinue).Source
        if ($found -and (Test-UsablePython $found)) {
            return $found
        }
    }
    return $null
}

$PythonExe = Find-Python
if (-not $PythonExe) {
    Write-Host "ERROR: No usable Python 3.10-3.13 found." -ForegroundColor Red
    Write-Host "Please install Python 3.11: https://www.python.org/downloads/" -ForegroundColor Yellow
    exit 1
}
Write-Host "Python: $PythonExe" -ForegroundColor Green
$PyVer = & $PythonExe --version 2>&1
Write-Host "       $PyVer"
Write-Host ""

# ------------------------------------------------------------------
# 2. 创建 venv
# ------------------------------------------------------------------
if (Test-Path $Venv) {
    Write-Host "venv already exists: $Venv" -ForegroundColor Yellow
    Write-Host "To recreate: Remove-Item -Recurse -Force '$Venv'" -ForegroundColor DarkGray
} else {
    Write-Host "Creating venv..." -ForegroundColor Cyan
    & $PythonExe -m venv $Venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to create venv" -ForegroundColor Red
        exit 1
    }
    Write-Host "venv created." -ForegroundColor Green
}

# Upgrade pip
Write-Host "Upgrading pip..." -ForegroundColor Cyan
& $VenvPy -m pip install --upgrade pip --quiet
Write-Host ""

# ------------------------------------------------------------------
# 3. 安装 torch（按 GPU 选择 index）
# ------------------------------------------------------------------
Write-Host "Detecting GPU..." -ForegroundColor Cyan
$nvidia = (Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$hasGPU = $nvidia -ne $null

if ($hasGPU) {
    # Check if RTX 50 series (Blackwell, needs cu128)
    $gpuInfo = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
    Write-Host "GPU: $gpuInfo" -ForegroundColor Green
    
    if ($gpuInfo -match 'RTX 50') {
        Write-Host "Blackwell GPU detected -> using torch cu128" -ForegroundColor Cyan
        & $VenvPy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
    } else {
        Write-Host "NVIDIA GPU -> using torch cu126" -ForegroundColor Cyan
        & $VenvPy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
    }
} else {
    Write-Host "No NVIDIA GPU -> CPU torch" -ForegroundColor Yellow
    & $VenvPy -m pip install torch torchaudio
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: torch install failed" -ForegroundColor Red
    exit 1
}
Write-Host "torch installed." -ForegroundColor Green
Write-Host ""

# ------------------------------------------------------------------
# 4. 安装其余依赖
# ------------------------------------------------------------------
Write-Host "Installing python packages..." -ForegroundColor Cyan
& $VenvPy -m pip install -r "$Root\requirements.txt"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pip install failed" -ForegroundColor Red
    exit 1
}
Write-Host ""

# ------------------------------------------------------------------
# 5. llama-cpp-python（可选，仅当使用本地 GGUF 模型时需要）
# ------------------------------------------------------------------
# 当前使用 Ollama（推荐），不需要 llama-cpp-python。
# 如需本地 GGUF 推理，取消下面注释：
# Write-Host "Installing llama-cpp-python..." -ForegroundColor Cyan
# if ($hasGPU) {
#     $env:CMAKE_ARGS = "-DGGML_CUDA=on"
#     & $VenvPy -m pip install llama-cpp-python --force-reinstall --no-cache-dir
# } else {
#     & $VenvPy -m pip install llama-cpp-python
# }
# Write-Host ""
Write-Host "[SKIP] llama-cpp-python (using Ollama instead)" -ForegroundColor DarkGray

# ------------------------------------------------------------------
# 6. 验证
# ------------------------------------------------------------------
Write-Host "=== Verifying installation ===" -ForegroundColor Cyan
& $VenvPy -c "import torch; print(f'torch {torch.__version__} (CUDA: {torch.cuda.is_available()})')"
& $VenvPy -c "import funasr; print(f'funasr {funasr.__version__}')"
& $VenvPy -c "import soundfile; print('soundfile OK')"
& $VenvPy -c "import librosa; print('librosa OK')"
& $VenvPy -c "import yaml; print('yaml OK')"
& $VenvPy -c "import demucs; print('demucs OK')"

# 检查 Ollama 是否可用
Write-Host ""
Write-Host "Checking Ollama..." -ForegroundColor Cyan
try {
    $ollamaCheck = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -Method Get -TimeoutSec 5 -ErrorAction Stop
    Write-Host "Ollama: running" -ForegroundColor Green
    $qwenModel = $ollamaCheck.models | Where-Object { $_.name -like "qwen3*" }
    if ($qwenModel) {
        Write-Host "LLM model: $($qwenModel.name -join ', ')" -ForegroundColor Green
    } else {
        Write-Host "WARNING: No qwen3 model found in Ollama. Please run: ollama pull qwen3:14b" -ForegroundColor Yellow
    }
} catch {
    Write-Host "WARNING: Ollama not reachable. Please ensure 'ollama serve' is running." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Ensure Ollama is running with qwen3:14b model" -ForegroundColor White
Write-Host "  2. Place test WAV files in:   $Root\sample_wav\" -ForegroundColor White
Write-Host "  3. (Optional) Add voiceprint:  $Root\voiceprint\" -ForegroundColor White
Write-Host "  4. Edit config.yaml if needed" -ForegroundColor White
Write-Host "  5. Run: $VenvPy pipeline.py run" -ForegroundColor White
Write-Host ""
