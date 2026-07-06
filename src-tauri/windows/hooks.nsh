; NSIS hooks：安装结束后可选配置本地语音模型。
; - Qwen3-TTS（PyTorch）：跨平台本地后端，任意 Windows 用户可配（不需 NVIDIA）。
; - IndexTTS-2 / CosyVoice3：GPU 大模型，面向 Windows + NVIDIA。
; macOS 不走此流程。
;
; 卸载（NSIS_HOOK_PREUNINSTALL）：在 Section Uninstall 开头询问用户
; 是否要删除本地语音模型（.venv-qwen3 / index-tts / CosyVoice / pretrained_models）。
; 用户选「否」（默认）= 保留模型，省去数 GB～十余 GB 的重下载。

!macro NSIS_HOOK_POSTINSTALL
  ; ---- 1. Qwen3-TTS（PyTorch 本地后端，普适）----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否配置本地 Qwen3-TTS（PyTorch）？$\r$\n$\r$\n\
跨平台本地语音后端，零样本克隆参考音频。$\r$\n\
会创建独立 Python 环境 .venv-qwen3 并安装 torch + qwen-tts（约数 GB）。$\r$\n\
有 NVIDIA 显卡会自动装 CUDA 版 torch（RTX 50 系用 cu128）；无卡则用 CPU（较慢）。$\r$\n$\r$\n\
选「否」可稍后运行 scripts\windows\setup-qwen3-tts.cmd 手动配置。" \
    IDYES qwen3_setup IDNO qwen3_skip

  qwen3_setup:
    IfFileExists "$INSTDIR\scripts\windows\setup-qwen3-tts.cmd" 0 qwen3_missing
      ExecWait '"$INSTDIR\scripts\windows\setup-qwen3-tts.cmd"'
      Goto qwen3_skip
    qwen3_missing:
      MessageBox MB_ICONEXCLAMATION "未找到配置脚本：$INSTDIR\scripts\windows\setup-qwen3-tts.cmd"
  qwen3_skip:

  ; ---- 2. GPU 大模型（IndexTTS-2 / CosyVoice3，仅 NVIDIA）----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否配置 NVIDIA GPU 本地语音模型？$\r$\n$\r$\n\
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

; 卸载阶段钩子：在 NSIS 删除任何文件前弹出确认。
; 由于 NSIS 默认卸载会尝试删 $INSTDIR 子目录，但 index-tts / CosyVoice /
; pretrained_models / .venv-qwen3 不是 resources，不会被 resources_ancestors 枚举到，
; RMDir 在非空目录上会失败——所以**默认行为已经保留**这些模型。
; 这里再加一个显式确认，让"想彻底清空"的用户主动选 Yes。
;
; 注意：弹窗在 PreUninstall 时机触发，发生在 Section Uninstall 内。
; 此时若用户从「控制面板 → 程序和功能」走正常卸载流程，弹窗会出现。
!macro NSIS_HOOK_PREUNINSTALL
  ; 仅在交互模式（非 /P、/S、/UPDATE）下弹窗，避免静默卸载卡住
  ${IfNot} $PassiveMode == 1
  ${AndIfNot} ${Silent}
  ${AndIfNot} $UpdateMode == 1
    ; 检查是否有模型/环境存在（任意一个）
    IfFileExists "$INSTDIR\scripts\local-realtime\.venv-qwen3" 0 kxyy_no_models
    IfFileExists "$INSTDIR\scripts\local-realtime\index-tts" 0 kxyy_no_models
    IfFileExists "$INSTDIR\scripts\local-realtime\CosyVoice" 0 kxyy_no_models
    IfFileExists "$INSTDIR\scripts\local-realtime\pretrained_models" 0 kxyy_no_models
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "检测到本地语音模型/环境：$\r$\n\
  • $INSTDIR\scripts\local-realtime\.venv-qwen3$\r$\n\
  • $INSTDIR\scripts\local-realtime\index-tts$\r$\n\
  • $INSTDIR\scripts\local-realtime\CosyVoice$\r$\n\
  • $INSTDIR\scripts\local-realtime\pretrained_models$\r$\n$\r$\n\
是否同时删除这些本地模型/环境？$\r$\n$\r$\n\
默认「否」= 保留（可节省数 GB～十余 GB 下载）。$\r$\n\
选「是」= 彻底清空。" \
        IDYES kxyy_delete_models IDNO kxyy_keep_models
      kxyy_delete_models:
        ; RmDir /r 失败也无害（目录可能不存在）
        RmDir /r "$INSTDIR\scripts\local-realtime\.venv-qwen3"
        RmDir /r "$INSTDIR\scripts\local-realtime\index-tts"
        RmDir /r "$INSTDIR\scripts\local-realtime\CosyVoice"
        RmDir /r "$INSTDIR\scripts\local-realtime\pretrained_models"
        DetailPrint "已删除本地语音模型/环境。"
        Goto kxyy_models_done
      kxyy_keep_models:
        DetailPrint "保留本地语音模型/环境。"
        Goto kxyy_models_done
      kxyy_no_models:
        ; 所有目录都不存在，不弹窗
    kxyy_models_done:
  ${EndIf}
!macroend
