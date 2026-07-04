# Windows + NVIDIA：可选安装 IndexTTS-2 / CosyVoice3 本地模型。
# 由安装程序 POSTINSTALL 调用，也可手动运行：
#   powershell -ExecutionPolicy Bypass -File scripts/windows/setup-gpu-voice.ps1
#
# 模型体积大（数 GB～十余 GB），需网络与足够磁盘。

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "scripts\local-realtime"))) {
  # 安装目录：脚本在 $INSTDIR\scripts\windows
  $Root = Split-Path -Parent $PSScriptRoot
}
$Lr = Join-Path $Root "scripts\local-realtime"
$Models = Join-Path $Lr "pretrained_models"

Write-Host ""
Write-Host "=== 元元桌宠 · GPU 本地语音模型配置 ===" -ForegroundColor Cyan
Write-Host "安装目录: $Lr"
Write-Host ""
Write-Host "macOS 本地语音仅使用 Qwen3-TTS；以下模型面向 NVIDIA Windows。"
Write-Host ""

$installIndex = $false
$installCosy = $false

$r1 = Read-Host "安装 IndexTTS-2（复刻+情绪，推荐）? [Y/n]"
if ($r1 -eq "" -or $r1 -match '^[Yy]') { $installIndex = $true }

$r2 = Read-Host "安装 CosyVoice3 开源权重? [y/N]"
if ($r2 -match '^[Yy]') { $installCosy = $true }

if (-not $installIndex -and -not $installCosy) {
  Write-Host "未选择任何模型，退出。"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Models | Out-Null

function Ensure-GitRepo($Url, $Dest) {
  if (Test-Path $Dest) {
    Write-Host "已存在: $Dest"
    return
  }
  Write-Host "克隆 $Url ..."
  git clone --recursive $Url $Dest
  if ($LASTEXITCODE -ne 0) { throw "git clone 失败: $Url" }
}

function Try-Download-ModelScope($ModelId, $LocalDir) {
  # 优先 modelscope CLI；没有则提示手动下载
  $ms = Get-Command modelscope -ErrorAction SilentlyContinue
  if ($ms) {
    Write-Host "使用 modelscope 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & modelscope download --model $ModelId --local_dir $LocalDir
    return $LASTEXITCODE -eq 0
  }
  $hf = Get-Command huggingface-cli -ErrorAction SilentlyContinue
  if ($hf) {
    Write-Host "使用 huggingface-cli 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & huggingface-cli download $ModelId --local-dir $LocalDir
    return $LASTEXITCODE -eq 0
  }
  return $false
}

if ($installIndex) {
  Write-Host ""
  Write-Host "--- IndexTTS-2 ---" -ForegroundColor Yellow
  $repo = Join-Path $Lr "index-tts"
  $ckpt = Join-Path $Models "IndexTTS-2"
  Ensure-GitRepo "https://github.com/index-tts/index-tts.git" $repo
  if (-not (Test-Path (Join-Path $ckpt "config.yaml"))) {
    $ok = Try-Download-ModelScope "IndexTeam/IndexTTS-2" $ckpt
    if (-not $ok) {
      Write-Host "未能自动下载权重。请按 index-tts README 将 checkpoints 放到:" -ForegroundColor Red
      Write-Host "  $ckpt"
      Write-Host "并确保存在 config.yaml"
    }
  } else {
    Write-Host "权重已存在: $ckpt"
  }
  Write-Host "请在 $repo 中创建 venv 并安装依赖（见 README），例如:"
  Write-Host "  cd `"$repo`""
  Write-Host "  python -m venv .venv"
  Write-Host "  .\.venv\Scripts\activate"
  Write-Host "  pip install -r requirements.txt"
}

if ($installCosy) {
  Write-Host ""
  Write-Host "--- CosyVoice3 ---" -ForegroundColor Yellow
  $repo = Join-Path $Lr "CosyVoice"
  $ckpt = Join-Path $Models "Fun-CosyVoice3-0.5B"
  Ensure-GitRepo "https://github.com/FunAudioLLM/CosyVoice.git" $repo
  if (-not (Test-Path $ckpt)) {
    $ok = Try-Download-ModelScope "FunAudioLLM/Fun-CosyVoice3-0.5B-2512" $ckpt
    if (-not $ok) {
      Write-Host "未能自动下载权重。请手动下载 Fun-CosyVoice3-0.5B-2512 到:" -ForegroundColor Red
      Write-Host "  $ckpt"
    }
  } else {
    Write-Host "权重已存在: $ckpt"
  }
  Write-Host "请在 $repo 中按 README 安装依赖（建议 conda/venv + CUDA）。"
}

# 写入标记，供应用识别「安装器已配置过」
$flag = Join-Path $env:LOCALAPPDATA "com.aaronfang.kxyydesktoppet\gpu-voice-setup.json"
New-Item -ItemType Directory -Force -Path (Split-Path $flag) | Out-Null
@{
  indexTts2 = $installIndex
  cosyvoice3 = $installCosy
  configuredAt = (Get-Date).ToString("o")
  localRealtime = $Lr
} | ConvertTo-Json | Set-Content -Path $flag -Encoding UTF8

Write-Host ""
Write-Host "配置完成。请在桌宠设置中选择对应语音后端并保存以自动启动服务。" -ForegroundColor Green
Write-Host "按 Enter 关闭…"
[void][System.Console]::ReadLine()
