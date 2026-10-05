# Mage-VL 本地观察服务（M1 原型）

这是一个仅监听回环地址的图片观察服务，供桌宠的共同体验模式调用。窗口截图和媒体音频由 Tauri 按用户选择的 window ID 捕获；原始数据只在内存/临时文件中短暂存在，不写入聊天、Memory 或诊断。

```bash
pip install "mlx-vlm==0.7.4" gradio opencv-python pillow
python server.py
```

服务地址为 `http://127.0.0.1:7861`。`POST /observe` 接收单图；主动陪看使用 `POST /observe-frames` 接收 2--4 张严格按时间递增的 JPEG，并通过 Mage-VL 的 video processor 保留时间位置。`mlx-vlm 0.7.1` 才开始支持该路径，项目固定到已验证的 `0.7.4`。首次运行会下载 `mlx-community/Mage-VL-8bit`（约 5GB）。

桌面应用使用会话级 `ScreenCaptureKit` helper 以 2 fps 维护最多 24 帧的内存缓冲。本地变化门控只把静态约 8 秒、普通约 4 秒、快速约 2 秒的代表窗口交给 Mage-VL；原始候选帧不会进入聊天或 Memory。

## 短视频窗口实测

先启动 observer，再运行以下命令。从显示的 macOS 窗口列表选择一个目标，工具录制 3--15 秒，视频仅作为一次本地请求处理，分析后立即删除。

```bash
python3 scripts/mage-vl/watch_window.py --seconds 10
```

macOS 首次录制会请求“屏幕录制”权限。截图只在本地短暂处理，不写入聊天、Memory 或诊断。

为保证可交互的本地推理，视频只均匀抽取 4 帧，并将每帧长边限制为 640 px；它用于概述画面变化，不用于逐帧复述内容。

连续观察测试会在启动时选择一次窗口，随后所有轮次固定使用同一个 window ID。默认目标节拍为 3 秒；推理严格串行、不并发堆积。如果某轮超过 3 秒，下一轮会在上一轮结束后立即开始，输出的 `latencyMs` 可用于观察落后程度：

```bash
npm run mage-vl:continuous -- --window-id 1054
# 或交互选择窗口并运行 5 轮
python3 scripts/mage-vl/watch_window.py --continuous --rounds 5 --interval 3
```

每轮输出 `round`、`latencyMs` 和摘要；截图只保存在临时目录，进程结束后清除。

要持续观察稳定性，可打开滚动监控窗口（`rounds=0` 表示一直运行，点击“停止”结束）：

```bash
python3 scripts/mage-vl/monitor_window.py --interval 3
```

## 窗口媒体音频与 SenseVoice

桌面应用在 macOS 上首次需要系统音频/屏幕录制权限。`capture_audio.swift` 使用 ScreenCaptureKit 的指定窗口音频轨，输出 16kHz 单声道 PCM WAV；Tauri 会在缓存目录编译并复用 helper。随后短 WAV 通过本地语音服务的鉴权 `POST /asr` 进入当前 SenseVoice adapter，服务不会保存原始音频。

独立验证指定窗口音频采集：

```bash
swiftc -O -framework AppKit -framework ScreenCaptureKit -framework CoreMedia -framework AudioToolbox \
  capture_audio.swift -o /tmp/kxyy-capture-audio
/tmp/kxyy-capture-audio --window-id <window-id> --duration-ms 2500 --output /tmp/window.wav
```

`/asr` 只接受有界的 16kHz/16-bit/mono WAV，并要求本地 voice service 的 `X-Tts-Secret`；不要把它暴露到非 loopback 网络。
