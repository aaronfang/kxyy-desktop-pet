; NSIS hooks：安装结束后可选配置 NVIDIA 本地语音模型（IndexTTS-2 / CosyVoice3）。
; macOS 不走此流程；Windows 用户可在此选择下载/克隆大模型。

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否配置 NVIDIA 本地语音模型？$\r$\n$\r$\n\
可选：IndexTTS-2、CosyVoice3 开源权重。$\r$\n\
需要较大磁盘空间与网络下载，并建议已安装 Git、CUDA。$\r$\n$\r$\n\
选「否」可稍后在设置中手动配置，或运行 scripts\windows\setup-gpu-voice.cmd。" \
    IDYES gpu_voice_setup IDNO gpu_voice_skip

  gpu_voice_setup:
    ; 资源文件随安装包放到 $INSTDIR（见 tauri.conf resources）
    IfFileExists "$INSTDIR\scripts\windows\setup-gpu-voice.cmd" 0 gpu_voice_missing
      ExecWait '"$INSTDIR\scripts\windows\setup-gpu-voice.cmd"'
      Goto gpu_voice_skip
    gpu_voice_missing:
      MessageBox MB_ICONEXCLAMATION "未找到配置脚本：$INSTDIR\scripts\windows\setup-gpu-voice.cmd"
  gpu_voice_skip:
!macroend
