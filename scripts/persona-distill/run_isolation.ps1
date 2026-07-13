# ============================================================================
# 声源隔离：从 vocals 轨中只保留元元声音，其余（含背景唱歌）静音
#
# 运行时间：约 5-8 分钟（取决于 GPU）
# 输出：output/isolation/filtered_vocals.wav（与原始等长，非元元段为零）
# ============================================================================

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$VOCALS = "output/vocals/htdemucs/260606-开心元元直播录屏分享26年6月5日-p01/vocals.wav"
$OUTPUT = "output/isolation/filtered_vocals.wav"
$LOGFILE = "output/isolation/_full_run.log"

Write-Host "=== 声源隔离 (Full) ===" -ForegroundColor Cyan
Write-Host "Input:  $VOCALS"
Write-Host "Output: $OUTPUT"
Write-Host "Log:    $LOGFILE"
Write-Host ""

# Step 1: Speaker labeling (VAD + CAM++ + KMeans) — saves to .labels.json
Write-Host "[1/2] Speaker labeling..." -ForegroundColor Yellow
$LABELS = "$PSScriptRoot/output/isolation/filtered_vocals.labels.json"

if (Test-Path $LABELS) {
    Write-Host "  Labels already exist: $LABELS (skip re-run)"
} else {
    & .venv-distill/Scripts/python.exe steps/isolation_v2.py `
        $VOCALS $OUTPUT `
        --device cuda `
        --labels-only `
        2>&1 | Tee-Object -FilePath $LOGFILE
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Labeling failed. See $LOGFILE" -ForegroundColor Red
        exit 1
    }
}

# Step 2: Build filtered audio (streaming)
Write-Host ""
Write-Host "[2/2] Building filtered audio (streaming)..." -ForegroundColor Yellow
& .venv-distill/Scripts/python.exe steps/isolation_v2.py `
    $VOCALS $OUTPUT `
    --device cuda `
    --fade-ms 10 `
    2>&1 | Tee-Object -FilePath $LOGFILE -Append

if ($LASTEXITCODE -eq 0) {
    $size = (Get-Item $OUTPUT).Length / 1MB
    Write-Host ""
    Write-Host "=== DONE ===" -ForegroundColor Green
    Write-Host "Filtered audio: $OUTPUT ($([math]::Round($size,1)) MB)"
    Write-Host "Metadata:       $($OUTPUT -replace '\.wav$', '.isolation.json')"
} else {
    Write-Host "ERROR: Build failed. See $LOGFILE" -ForegroundColor Red
    exit 1
}
