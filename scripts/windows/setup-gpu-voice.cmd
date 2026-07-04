@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-gpu-voice.ps1"
if errorlevel 1 pause
endlocal
