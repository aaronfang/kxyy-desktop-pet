# Windows + NVIDIA：可选安装 IndexTTS-2 / CosyVoice3 本地模型。
# 由安装程序 POSTINSTALL 调用，也可手动运行：
#   powershell -ExecutionPolicy Bypass -File scripts/windows/setup-gpu-voice.ps1
#
# 非交互模式（由应用自动拉起）：
#   powershell -ExecutionPolicy Bypass -File scripts/windows/setup-gpu-voice.ps1 -NonInteractive -Backend indextts2
#
# 模型体积大（数 GB～十余 GB），需网络与足够磁盘。

param(
  [switch]$NonInteractive,
  [string]$Backend = ""   # indextts2 / cosyvoice3 / both
)

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

$installIndex = $false
$installCosy = $false

if ($NonInteractive) {
  switch ($Backend.ToLowerInvariant()) {
    "indextts2" { $installIndex = $true }
    "cosyvoice3" { $installCosy = $true }
    "both" { $installIndex = $true; $installCosy = $true }
    default {
      Write-Host "STEP 错误：非交互模式需指定 -Backend indextts2|cosyvoice3|both，收到：$Backend"
      exit 1
    }
  }
} else {
  Write-Host ""
  Write-Host "=== 元元桌宠 · GPU 本地语音模型配置 ===" -ForegroundColor Cyan
  Write-Host "安装目录: $Lr"
  Write-Host ""
  Write-Host "macOS 本地语音仅使用 Qwen3-TTS；以下模型面向 NVIDIA Windows。"
  Write-Host ""

  $r1 = Read-Host "安装 IndexTTS-2（复刻+情绪，推荐）? [Y/n]"
  if ($r1 -eq "" -or $r1 -match '^[Yy]') { $installIndex = $true }

  $r2 = Read-Host "安装 CosyVoice3 开源权重? [y/N]"
  if ($r2 -match '^[Yy]') { $installCosy = $true }

  if (-not $installIndex -and -not $installCosy) {
    Write-Host "未选择任何模型，退出。"
    exit 0
  }
}

New-Item -ItemType Directory -Force -Path $Models | Out-Null

function Ensure-GitRepo($Url, $Dest) {
  if (Test-Path $Dest) {
    Write-Host "STEP git 仓库已存在: $Dest"
    return $true
  }
  Write-Host "STEP 正在 git clone（可能较慢，取决于网络）..."
  Write-Host "STEP git clone $Url -> $Dest"
  git clone --recursive $Url $Dest
  if ($LASTEXITCODE -ne 0) {
    Write-Host "STEP 错误：git clone 失败 (exit=$LASTEXITCODE)"
    return $false
  }
  Write-Host "STEP git clone 完成"
  return $true
}

# 依次探测可用 Python（GPU 后端需 3.10–3.13，3.14+ 无 PyTorch wheel）。
# 优先版本化 python3.11/3.12/3.13，再回退 generic python/py/python3。
function Find-Python {
  # 常见用户安装路径（如 pipx/uv 安装的独立版本）
  foreach ($ver in @('3.11','3.12','3.13')) {
    $candidates = @(
      "python$ver",
      "$env:LOCALAPPDATA\Microsoft\WindowsApps\python$ver.exe",
      "$env:LOCALAPPDATA\Programs\Python\Python${ver}1*\python.exe",
      "$env:USERPROFILE\.local\bin\python$ver.exe"
    )
    foreach ($c in $candidates) {
      if (Get-Command $c -ErrorAction SilentlyContinue) {
        $v = & $c --version 2>&1 | Out-String
        if ($v -match 'Python\s+(\d+)\.(\d+)') {
          $minor = [int]$Matches[2]
          if ($minor -ge 10 -and $minor -le 13) { return $c }
        }
      }
    }
  }
  # 回退：generic python/py — 但跳过 3.14+
  foreach ($c in @('python','py','python3')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
      $v = & $c --version 2>&1 | Out-String
      if ($v -match 'Python\s+(\d+)\.(\d+)') {
        $minor = [int]$Matches[2]
        if ($minor -le 13) { return $c }
        Write-Host "STEP 跳过 Python 3.$minor（GPU 后端不支持 3.14+），搜索其他版本…"
      }
    }
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
  Write-Host "STEP 未检测到 modelscope / huggingface-cli；通过 $py -m pip 安装 modelscope（约 100 MB）..."
  $pipLog = Join-Path $env:TEMP "kxyy-pip-install.log"
  $pipProc = Start-Process -FilePath $py -ArgumentList @(
    '-m','pip','install','--upgrade','--disable-pip-version-check','modelscope'
  ) -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $pipLog -RedirectStandardError "$pipLog.err"
  $pipExit = $pipProc.ExitCode
  if ($pipExit -ne 0) {
    Write-Host "STEP pip install modelscope 失败 (exit=$pipExit)；将走手动下载兜底"
    if (Test-Path "$pipLog.err") {
      Get-Content "$pipLog.err" -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
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
    Write-Host "STEP 使用 modelscope 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & modelscope download --model $ModelId --local_dir $LocalDir
    if ($LASTEXITCODE -eq 0) {
      Write-Host "STEP 模型下载完成"
      return $true
    }
    Write-Host "STEP modelscope 下载失败 (exit=$LASTEXITCODE)，尝试 huggingface-cli 兜底"
  }
  if ($cli -eq 'huggingface-cli' -or (Get-Command huggingface-cli -ErrorAction SilentlyContinue)) {
    Write-Host "STEP 使用 huggingface-cli 下载 $ModelId -> $LocalDir"
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    & huggingface-cli download $ModelId --local-dir $LocalDir
    if ($LASTEXITCODE -eq 0) {
      Write-Host "STEP 模型下载完成"
      return $true
    }
    Write-Host "STEP huggingface-cli 下载失败 (exit=$LASTEXITCODE)"
  }
  return $false
}

# 自动创建 venv 并安装依赖（非交互模式）
function AutoSetup-Venv($RepoDir, $RequirementsFile) {
  $py = Find-Python
  if (-not $py) {
    Write-Host "STEP 错误：未找到 Python，无法创建 venv"
    return $false
  }
  $venvDir = Join-Path $RepoDir ".venv"
  $venvPython = Join-Path $venvDir "Scripts\python.exe"
  if (Test-Path $venvPython) {
    $v = & $venvPython --version 2>&1 | Out-String
    if ($v -match 'Python\s+(\d+)\.(\d+)') {
      $minor = [int]$Matches[2]
      if ($minor -ge 14) {
        Write-Host "STEP 已有 venv 使用 Python 3.$minor （GPU 后端不支持 3.14+），删除重建…"
        Remove-Item -Recurse -Force $venvDir
      } else {
        Write-Host "STEP venv 已存在: $venvDir"
      }
    }
  }
  if (-not (Test-Path $venvPython)) {
    Write-Host "STEP 创建 venv: $venvDir"
    $result = & $py -m venv $venvDir 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "STEP 错误：venv 创建失败"
      Write-Host $result
      return $false
    }
    Write-Host "STEP venv 创建完成"
  }

  # 安装 repo 自身依赖：优先 requirements.txt，其次 pip install -e .
  $reqPath = Join-Path $RepoDir $RequirementsFile
  $hasRequirements = $RequirementsFile -and (Test-Path $reqPath)
  $hasSetup = (Test-Path (Join-Path $RepoDir "pyproject.toml")) -or (Test-Path (Join-Path $RepoDir "setup.py"))

  if ($hasRequirements) {
    Write-Host "STEP 安装 pip 依赖 ($RequirementsFile)..."
    $pipArgs = @('-m','pip','install','--disable-pip-version-check','-r',$reqPath)
    $pipProc = Start-Process -FilePath $venvPython -ArgumentList $pipArgs -Wait -PassThru -NoNewWindow
    if ($pipProc.ExitCode -ne 0) {
      Write-Host "STEP 警告：pip install -r 返回非零 exit=$($pipProc.ExitCode)"
    } else {
      Write-Host "STEP pip 依赖安装完成"
    }
  }

  if ($hasSetup) {
    Write-Host "STEP 安装 repo 自身 (pip install -e .)..."
    $editableArgs = @('-m','pip','install','--disable-pip-version-check','-e',$RepoDir)
    $editProc = Start-Process -FilePath $venvPython -ArgumentList $editableArgs -Wait -PassThru -NoNewWindow
    if ($editProc.ExitCode -ne 0) {
      Write-Host "STEP 警告：pip install -e . 返回非零 exit=$($editProc.ExitCode)"
    } else {
      Write-Host "STEP pip install -e . 完成"
    }
  }

  if (-not $hasRequirements -and -not $hasSetup) {
    Write-Host "STEP 警告：未找到 requirements.txt / pyproject.toml / setup.py，跳过 repo 依赖安装"
  }

  # 安装桌宠语音服务额外依赖
  Write-Host "STEP 安装 websockets certifi..."
  $extraArgs = @('-m','pip','install','--disable-pip-version-check','websockets','certifi')
  $extraProc = Start-Process -FilePath $venvPython -ArgumentList $extraArgs -Wait -PassThru -NoNewWindow
  if ($extraProc.ExitCode -ne 0) {
    Write-Host "STEP 警告：pip install websockets certifi 返回非零 exit=$($extraProc.ExitCode)"
  } else {
    Write-Host "STEP 额外依赖安装完成"
  }

  return $true
}

if ($installIndex) {
  Write-Host "STEP 开始配置 IndexTTS-2"
  $repo = Join-Path $Lr "index-tts"
  $ckpt = Join-Path $Models "IndexTTS-2"

  $cloneOk = Ensure-GitRepo "https://github.com/index-tts/index-tts.git" $repo
  if (-not $cloneOk) {
    Write-Host "STEP 错误：IndexTTS-2 源码克隆失败，无法继续。请检查 git 是否可用、网络是否正常。"
    exit 1
  }

  if (-not (Test-Path (Join-Path $ckpt "config.yaml"))) {
    $ok = Try-Download-ModelScope "IndexTeam/IndexTTS-2" $ckpt
    if (-not $ok) {
      Write-Host "STEP 错误：未能自动下载 IndexTTS-2 权重。"
      Write-Host "STEP 请手动下载到: $ckpt"
      Write-Host "STEP ModelScope: https://www.modelscope.cn/models/IndexTeam/IndexTTS-2"
      Write-Host "STEP HuggingFace: https://huggingface.co/IndexTeam/IndexTTS-2"
      exit 1
    }
  } else {
    Write-Host "STEP 权重已存在: $ckpt"
  }

  if ($NonInteractive) {
    $venvOk = AutoSetup-Venv $repo "requirements.txt"
    if (-not $venvOk) {
      Write-Host "STEP 错误：IndexTTS-2 venv 配置失败"
      exit 1
    }
  } else {
    Write-Host "请在 $repo 中创建 venv 并安装依赖（见 README），例如:"
    Write-Host "  cd `"$repo`""
    Write-Host "  python -m venv .venv"
    Write-Host "  .\.venv\Scripts\activate"
    Write-Host "  pip install -r requirements.txt"
    Write-Host "  pip install websockets certifi   # 桌宠语音服务自身依赖"
  }
  Write-Host "STEP IndexTTS-2 配置完成"
}

if ($installCosy) {
  Write-Host "STEP 开始配置 CosyVoice3"
  $repo = Join-Path $Lr "CosyVoice"
  $ckpt = Join-Path $Models "Fun-CosyVoice3-0.5B"

  $cloneOk = Ensure-GitRepo "https://github.com/FunAudioLLM/CosyVoice.git" $repo
  if (-not $cloneOk) {
    Write-Host "STEP 错误：CosyVoice 源码克隆失败，无法继续。请检查 git 是否可用、网络是否正常。"
    exit 1
  }

  if (-not (Test-Path $ckpt)) {
    $ok = Try-Download-ModelScope "FunAudioLLM/Fun-CosyVoice3-0.5B-2512" $ckpt
    if (-not $ok) {
      Write-Host "STEP 错误：未能自动下载 CosyVoice3 权重。"
      Write-Host "STEP 请手动下载到: $ckpt"
      Write-Host "STEP ModelScope: https://www.modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512"
      Write-Host "STEP HuggingFace: https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512"
      exit 1
    }
  } else {
    Write-Host "STEP 权重已存在: $ckpt"
  }

  if ($NonInteractive) {
    $venvOk = AutoSetup-Venv $repo "requirements.txt"
    if (-not $venvOk) {
      Write-Host "STEP 错误：CosyVoice3 venv 配置失败"
      exit 1
    }
  } else {
    Write-Host "请在 $repo 中按 README 安装依赖（建议 conda/venv + CUDA）。"
    Write-Host "  安装后别忘了：pip install websockets certifi   # 桌宠语音服务自身依赖"
  }
  Write-Host "STEP CosyVoice3 配置完成"
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
Write-Host "STEP 全部配置完成" -ForegroundColor Green

if (-not $NonInteractive) {
  Write-Host "按 Enter 关闭…"
  [void][System.Console]::ReadLine()
}
