# Windows + NVIDIA：可选安装 IndexTTS-2 / CosyVoice3 本地模型。
# 由安装程序 POSTINSTALL 调用，也可手动运行：
#   powershell -ExecutionPolicy Bypass -File scripts/windows/setup-gpu-voice.ps1
#
# 模型体积大（数 GB～十余 GB），需网络与足够磁盘。

# 注意：$ErrorActionPreference 保持默认（Continue）。
# 设为 Stop 时，PS 5.1 在 native command（python.exe / git.exe）写 stderr 时
# 会把它当作 error record 立即 throw——包括 pip 的 [notice] / SSL 警告、
# git 的 LF 警告等常见输出都会让脚本挂掉。所以下方关键调用都改用
# Start-Process（绕开 native-command error 机制）或显式检查 $LASTEXITCODE。
# 本脚本含中文，文件须以 UTF-8 + BOM 保存（PS 5.1 看到 BOM 才按 UTF-8 解析）。
# 同时把控制台输出编码切到 UTF-8，避免 cmd 窗口里中文乱码。
$ConsoleOutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = $ConsoleOutputEncoding
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

# 依次探测 python / py（Windows Python Launcher）/ python3；都没有返回 $null
function Find-Python {
  foreach ($c in @('python','py','python3','python3.11','python3.12','python3.13')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { return $c }
  }
  return $null
}

# 已有 modelscope / huggingface-cli 直接返回名字；都没有但系统装了 Python，
# 就用 python -m pip 装一份 modelscope，并把 Python 的 Scripts 加到本进程 PATH。
# 仍然不行返回 $null，由调用方走手动兜底。
function Ensure-ModelCli {
  if (Get-Command modelscope -ErrorAction SilentlyContinue) { return 'modelscope' }
  if (Get-Command huggingface-cli -ErrorAction SilentlyContinue) { return 'huggingface-cli' }
  $py = Find-Python
  if (-not $py) { return $null }
  Write-Host "未检测到 modelscope / huggingface-cli；尝试通过 $py -m pip 安装 modelscope（约 100 MB）..." -ForegroundColor Yellow
  # 注意：必须用 Start-Process 而非 `& $py ... | Out-Null`。
  # 原因：脚本上方设了 $ErrorActionPreference=Stop，PS 5.1 在 native command（python.exe）
  # 写 stderr 时会把它视为 error record 立即 throw（哪怕是 pip 自己的 [notice] / SSL 提示）。
  # 改用 Start-Process 走子进程 + RedirectStandard*，绕开 PS 的 native-command error 机制。
  $pipLog = Join-Path $env:TEMP "kxyy-pip-install.log"
  $pipProc = Start-Process -FilePath $py -ArgumentList @(
    '-m','pip','install','--upgrade','--disable-pip-version-check','modelscope'
  ) -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $pipLog -RedirectStandardError "$pipLog.err"
  $pipExit = $pipProc.ExitCode
  if ($pipExit -ne 0) {
    Write-Host "pip install modelscope 失败 (exit=$pipExit)；将走手动下载兜底" -ForegroundColor Yellow
    if (Test-Path "$pipLog.err") {
      Get-Content "$pipLog.err" -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
    }
    return $null
  }
  # 把刚装的 modelscope.exe / huggingface-cli.exe 加到本进程 PATH
  try {
    $scriptsDir = & $py -c "import sysconfig,os; print(os.path.join(sysconfig.get_paths()['scripts']))" 2>$null
    if ($scriptsDir -and (Test-Path $scriptsDir)) { $env:PATH = "$scriptsDir;$env:PATH" }
  } catch {}
  if (Get-Command modelscope -ErrorAction SilentlyContinue) { return 'modelscope' }
  if (Get-Command huggingface-cli -ErrorAction SilentlyContinue) { return 'huggingface-cli' }
  return $null
}

function Try-Download-ModelScope($ModelId, $LocalDir) {
  $cli = Ensure-ModelCli
  if ($cli -eq 'modelscope') {
    Write-Host "使用 modelscope 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & modelscope download --model $ModelId --local_dir $LocalDir
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host "modelscope 下载失败 (exit=$LASTEXITCODE)，尝试 huggingface-cli 兜底" -ForegroundColor Yellow
  }
  if ($cli -eq 'huggingface-cli' -or (Get-Command huggingface-cli -ErrorAction SilentlyContinue)) {
    Write-Host "使用 huggingface-cli 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & huggingface-cli download $ModelId --local-dir $LocalDir
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host "huggingface-cli 下载失败 (exit=$LASTEXITCODE)" -ForegroundColor Yellow
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
      Write-Host "未能自动下载权重。" -ForegroundColor Red
      Write-Host "请手动从以下任一地址下载 IndexTTS-2 权重并放到:"
      Write-Host "  $ckpt"
      Write-Host "ModelScope : https://www.modelscope.cn/models/IndexTeam/IndexTTS-2"
      Write-Host "HuggingFace: https://huggingface.co/IndexTeam/IndexTTS-2"
      Write-Host "也可参考已克隆仓库的 README: $repo\README.md"
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
  Write-Host "  pip install websockets certifi   # 桌宠语音服务自身依赖（不在模型 requirements 内）" -ForegroundColor Yellow
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
      Write-Host "未能自动下载权重。" -ForegroundColor Red
      Write-Host "请手动从以下任一地址下载 Fun-CosyVoice3-0.5B-2512 权重并放到:"
      Write-Host "  $ckpt"
      Write-Host "ModelScope : https://www.modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512"
      Write-Host "HuggingFace: https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512"
      Write-Host "也可参考已克隆仓库的 README: $repo\README.md"
    }
  } else {
    Write-Host "权重已存在: $ckpt"
  }
  Write-Host "请在 $repo 中按 README 安装依赖（建议 conda/venv + CUDA）。"
  Write-Host "  安装后别忘了：pip install websockets certifi   # 桌宠语音服务自身依赖" -ForegroundColor Yellow
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
