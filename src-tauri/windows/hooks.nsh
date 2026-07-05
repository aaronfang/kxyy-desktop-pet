; NSIS hooks：安装结束后可选配置 NVIDIA 本地语音模型（IndexTTS-2 / CosyVoice3）。
; macOS 不走此流程；Windows 用户可在此选择下载/克隆大模型。
;
; 卸载（NSIS_HOOK_PREUNINSTALL）：在 Section Uninstall 开头询问用户
; 是否要删除本地语音模型（IndexTTS-2 / CosyVoice3 / pretrained_models）。
; 用户选「否」（默认）= 保留模型，省去数 GB～十余 GB 的重下载。

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

; 卸载阶段钩子：在 NSIS 删除任何文件前弹出确认。
; 由于 NSIS 默认卸载会尝试删 $INSTDIR 子目录，但 index-tts / CosyVoice /
; pretrained_models 不是 resources，不会被 resources_ancestors 枚举到，
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
    ; 检查是否有模型存在（任意一个）
    IfFileExists "$INSTDIR\scripts\local-realtime\index-tts" 0 kxyy_no_models
    IfFileExists "$INSTDIR\scripts\local-realtime\CosyVoice" 0 kxyy_no_models
    IfFileExists "$INSTDIR\scripts\local-realtime\pretrained_models" 0 kxyy_no_models
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "检测到本地语音模型：$\r$\n\
  • $INSTDIR\scripts\local-realtime\index-tts$\r$\n\
  • $INSTDIR\scripts\local-realtime\CosyVoice$\r$\n\
  • $INSTDIR\scripts\local-realtime\pretrained_models$\r$\n$\r$\n\
是否同时删除这些本地模型？$\r$\n$\r$\n\
默认「否」= 保留模型（可节省数 GB～十余 GB 下载）。$\r$\n\
选「是」= 彻底清空。" \
        IDYES kxyy_delete_models IDNO kxyy_keep_models
      kxyy_delete_models:
        ; RmDir /r 失败也无害（目录可能不存在）
        RmDir /r "$INSTDIR\scripts\local-realtime\index-tts"
        RmDir /r "$INSTDIR\scripts\local-realtime\CosyVoice"
        RmDir /r "$INSTDIR\scripts\local-realtime\pretrained_models"
        DetailPrint "已删除本地语音模型。"
        Goto kxyy_models_done
      kxyy_keep_models:
        DetailPrint "保留本地语音模型。"
        Goto kxyy_models_done
      kxyy_no_models:
        ; 三个目录都不存在，不弹窗
    kxyy_models_done:
  ${EndIf}
!macroend
