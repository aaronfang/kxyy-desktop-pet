# Daisy-Voice-Agent 研究笔记

研究对象：[`forestai123456/Daisy-Voice-Agent`](https://github.com/forestai123456/Daisy-Voice-Agent)，截至 2026-07-26 的 `667bc4810bc637b5c995ac13179bfd92bfa04722`（浅克隆源码；MIT）。以下结论均来自该仓库 README 或源码，路径和行号对应上述提交。

## 工程轮廓

- Daisy 是仅面向 macOS Apple Silicon 的 Electron 42 + TypeScript 桌面语音助手；`package.json` 的打包目标只有 arm64 DMG，运行时依赖 `uiohook-napi`、`ws`、`node-edge-tts`、`@picovoice/porcupine-node` 等（[`package.json`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/package.json#L1-L92)）。README 明确将语音、系统操作、工具调用作为产品范围，并说明密钥只存本机（[`README.md`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/README.md#L17-L126)）。
- 主进程集中编排会话、ASR、LLM、TTS、全局快捷键和窗口；隐藏的 1x1 音频 BrowserWindow 负责获取麦克风，再通过 preload/contextBridge 将 PCM 送回主进程（[`src/main/audio/recorder.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/audio/recorder.ts#L39-L146)，[`src/preload/index.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/preload/index.ts#L1-L148)）。

## 值得借鉴

### 1. 会话代数 + 集中取消

`abortAllTasks()` 先递增 `currentSessionId`，再取消 LLM、停止 TTS/ASR、清除所有 timer、重置状态和录音，所有异步回调均用 `sessionId !== currentSessionId` 丢弃陈旧结果（[`src/main/index.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/index.ts#L358-L416)，LLM 回调示例 L747-L864）。这是简单但有效的“新回合赢”并发策略，适合 kxyy 的本地/Volcano 多后端切换、挂断和 barge-in；可以将当前 generation/lease 再映射到同一套不变量，并给每个事件带 generation 做确定性测试。

### 2. 录音资源的显式状态机和 ACK 超时

录音器定义 `IDLE → STARTING → RECORDING → STOPPING`，启动等待 `audio:ready`，停止等待 `audio:stopped`，分别有 10 秒和 1 秒兜底，并在 STOPPING 时排队下一次 start（[`src/main/audio/recorder.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/audio/recorder.ts#L6-L29)、L74-L104、L174-L237）。这类显式生命周期可借鉴到 Tauri 音频 Worklet/本地 voice service 的 prepare/start/stop，避免权限弹窗或渲染进程异常导致“卡死录音”。

### 3. 低延迟 PCM 采集的实用边界

渲染器请求单声道 48kHz、AEC、降噪、自动增益；重采样到 16kHz s16le，并把数据分片经 IPC 发送。音频窗口通过 generation 防止异步 `getUserMedia` 完成后污染新一轮资源；同时周期性恢复 suspended AudioContext（[`src/renderer/audio.js`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/renderer/audio.js#L116-L228)、L252-L280）。AEC/资源代数与 kxyy 的已有设置一致，可作为跨平台 WebView 兼容性清单；但 ScriptProcessor 是旧 API，不能替代现有 AudioWorklet。

### 4. ASR 网络边界与快速收尾

Volcano ASR 使用固定 100ms、16kHz PCM 分片，首包附流式 WAV 头，停止时发送最后包；WS 尚未握手时也会绑定“关闭这个 socket”的一次性回调，避免新会话替换 socket 后旧连接泄漏（[`src/main/asr/index.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/asr/index.ts#L15-L18)、L63-L115、L129-L185、L224-L260）。停止后以 300ms 轮询 partial 稳定度，最多 10 秒；无音频立即完成。可借鉴其 socket 身份和 flush/finish 竞态处理，但 kxyy 的最终 ASR、候选 deadline 和服务端协议约束应继续使用本项目已验证的实现。

### 5. 唤醒词的预滚动与纯能量 VAD

唤醒词监视器维护 500ms pre-roll；VAD 在非语音时自适应 noise floor，阈值为 `max(noiseFloor*2, 0.02)`，连续 2 秒低能量结束，录音最长 8 秒且至少 0.5 秒才调用 whisper.cpp（[`src/main/wakeword/monitor.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/wakeword/monitor.ts#L15-L20)、L80-L145、L223-L299）。pre-roll 是很有用的体验细节；不过该 VAD 只有绝对能量和硬编码阈值，不能作为 kxyy 的神经 VAD 或实时打断决策。

### 6. 流式 LLM 与有界 TTS 管线

LLM 通过 OpenAI-compatible SSE 逐块累积文本，同时解析 tool calls；最终答案分 display/speech 双通道，speech 清洗 Markdown/emoji 后按中文标点切句，先播前两句，其余约 200 字分块并串行预合成（[`src/main/index.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/index.ts#L811-L931)，[`src/main/tts/edgeTTS.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/tts/edgeTTS.ts#L33-L129)）。这验证了“首句尽快可听 + 后续边合成边排队”的方向；kxyy 应保留更严格的现有 bounded queue、播放回执和 generation/segment ledger，不要引入无上限文件队列。

### 7. 工具调用的循环护栏与历史完整性

`DeepSeekClient` 给每个工具设置调用上限、整个循环最多 100 步，并在历史裁剪后删除孤立的 assistant tool-call/tool response 组（[`src/main/llm/deepseek.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/llm/deepseek.ts#L163-L225)，[`src/main/llm/conversation.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/llm/conversation.ts#L76-L151)）。这是可直接借鉴的防死循环/防坏历史机制；调用上限应按 kxyy 每个工具的副作用和资源成本单独设定。

### 8. 桌面反馈和快捷键体验

快捷键支持按住触发、释放结束，释放有 50ms debounce；未获 Accessibility 权限时轮询等待（[`src/main/shortcut/globalShortcut.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/shortcut/globalShortcut.ts#L6-L16)、L190-L256）。悬浮球显示 listening/thinking/speaking 等状态，点击可静音当前回答但保留对话状态（[`src/main/index.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/index.ts#L328-L356)）。状态反馈思想适用于 kxyy 的 chat/capsule，但 Tauri 的 click-through 约束不同，不能照搬 Electron `setIgnoreMouseEvents`。

## 风险与不可照搬项

- **平台范围**：Electron 配置、`osascript`、Apple Silicon Whisper 动态库和辅助功能权限均为 macOS 专用；不能作为 kxyy Windows 方案或 Rust 后端协议依据。
- **高权限工具面**：工具列表包含读写/删除文件、运行 shell、控制应用、剪贴板和输入模拟（[`src/main/llm/tools.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/llm/tools.ts#L25-L40)、[`src/main/control/macos.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/control/macos.ts#L1450-L1475)）。部分实现通过字符串拼接 `osascript`/`bash -c`（如 macos.ts L844-L887），存在命令注入、误操作和授权范围过大的风险；kxyy 只应采用 allow-list、参数结构化、确认门和最小权限。
- **密钥与日志**：README 要求本地保存 key，但源码存在把 partial/final 文本写入日志的路径（如 `asr/index.ts` L67、L109、L183、L208；`index.ts` L472、L995）。kxyy 的诊断规范明确禁止文本、路径和原始错误，Daisy 的日志策略不能复用。
- **TTS 取消语义**：`EdgeTTSPlayer.stop()` 只设置 cancelled；网络合成仍可能继续，靠完成后删除文件（[`edgeTTS.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/tts/edgeTTS.ts#L51-L84)）。这比 kxyy 的 CancelScope/有界 Future 约束弱，不能据此放宽本地 voice service 的取消和 admission 规则。
- **测试覆盖**：仓库主要是 `scripts/self-test.js`（配置/路径模拟）和 `scripts/test-services.mjs`（需要真实 Edge TTS，LLM/ASR 无 key 时跳过），没有针对 ASR 帧状态、VAD 边界、TTS 队列或工具循环的确定性单元测试（[`scripts/self-test.js`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/scripts/self-test.js#L1-L166)、[`scripts/test-services.mjs`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/scripts/test-services.mjs#L1-L78)）。kxyy 不应以 Daisy 的测试深度作为标准。
- **历史裁剪近似**：会话用“字符数/4”估 token，且只保留最近 20 条消息（[`conversation.ts`](https://github.com/forestai123456/Daisy-Voice-Agent/blob/667bc4810bc637b5c995ac13179bfd92bfa04722/src/main/llm/conversation.ts#L6-L9)、L76-L99）；这可作简单 fallback，但不应替代 kxyy Memory v3 的结构化召回和敏感内容边界。

## 给 kxyy-desktop-pet 的优先建议

1. **高优先级**：把“会话代数 + 取消所有异步工作 + stale callback 丢弃”整理成共享测试夹具，覆盖文本聊天、Volcano、local/CosyVoice、窗口挂断四条路径。
2. **高优先级**：沿用 Daisy 的录音状态机/ACK/超时思想，审查 Tauri 音频窗口、AudioWorklet、voice-service manager 在权限拒绝、启动慢、重复 start/stop 下的状态转移。
3. **中优先级**：把“首句快速播放、后续边合成”作为性能对照实验；所有新实现必须服从现有 64 项队列、播放派生历史和 provider-pcm-v1 envelope。
4. **中优先级**：吸收工具循环的 per-tool/全局上限和 tool-message 完整性清理；不要引入 Daisy 那种任意 shell/脚本执行面。
5. **低优先级**：预滚动缓冲和状态可视化可用于桌宠交互细节；Daisy 的固定能量 VAD、whisper 唤醒词和 Electron IPC 仅作为对照，不进入实时决策或跨平台协议。

## 结论

Daisy 最有价值的不是某个供应商 API，而是桌面语音产品的几个工程模式：明确的录音生命周期、回合代数取消、ASR flush/final 竞态处理、首句优先的 TTS 管线和工具循环护栏。它的 macOS-only、高权限命令面、文本日志、弱取消和低确定性测试也说明了哪些地方必须继续遵守 kxyy 已有的 Rust/Worklet、隐私诊断、bounded queue 和 provider capability 约束。
