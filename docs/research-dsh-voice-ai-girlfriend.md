# dsh-voice-ai-girlfriend 对元元桌宠的借鉴价值调研（2026-08-16）

研究对象：[`beiyege-01/dsh-voice-ai-girlfriend`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend)，固定到 `main` 的 [`55b6a0a010d73b11120c7d69f754f6f9d92bef99`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/tree/55b6a0a010d73b11120c7d69f754f6f9d92bef99)。本报告只依据该提交的 README、源码、配置、提交历史与许可证，以及元元桌宠当前源码和权威路线图；没有把项目宣传语、开发日志中的主观体验或尚未复现的时延数字当成已验证性能结论。

## 结论

这个项目最值得借鉴的是**产品和模块边界**，不是实时语音内核：

1. 把录音、回复监听、逐句切分、播放、打断和陪伴视图拆成小组件，并通过一个窄接口组合；这对缩小元元桌宠当前 `RealtimeSession` 和 `chat.js` 的认知负担有直接价值。
2. 把“用户一开口是否立刻停播”和“识别完成后是打断当前生成还是排队到下一回合”区分为两个策略。这个分层值得做成本地/CosyVoice 的受控实验，但目标仓库现有 UI 把两者混在一个闪电图标附近，不能直接照搬交互。
3. 把安装前置条件、磁盘/显存成本、健康检查、STT/TTS 单项冒烟和常见故障写成普通用户可执行的闭环。元元桌宠已有更强的自动安装与运行时校验，但还可以补一个设置页“语音自检”入口，降低首次使用定位成本。
4. 朗读前清理 Markdown、代码块和 URL 是一个低成本防御性增强。元元桌宠已有动作提示清理和长度上限，但文字聊天朗读仍可补齐结构化内容过滤。

不建议迁移它的 RMS-only 打断、前端 PCM/utterance 队列、AudioBuffer 播放队列、单 GPU 全局推理锁、本地 HTTP 信任边界、错误输出方式或素材热加载实现。元元桌宠在候选打断、可恢复播放、有界队列、generation/lease、播放回执、Memory 和隐私诊断上已经明显更完整。

## 证据成熟度

- 仓库历史只有 4 次提交：核心代码全部来自 [`ea9e1c3` 初始提交](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/commit/ea9e1c39e2ec4f92356879c72cae796f572795c6)，后三次都是 README/配置文档修改；其中 [`4a89162`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/commit/4a89162669b7ce67de6152b3bace6b6f36609391) 还纠正了 VoiceDesign/Base 的模型选型，[`55b6a0a`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/commit/55b6a0a010d73b11120c7d69f754f6f9d92bef99) 又删除了作者示例台词。这说明项目是刚完成的单机集成样本，不是经历多版本演进的生产基线。
- JavaScript 包的脚本只有 `bundle` 和 `watch`，没有自动测试命令（[`dsh-plugin/package.json` L42-L45](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/package.json#L42-L45)）。仓库提供的是手工 STT/TTS 冒烟脚本；TTS 脚本检查 WAV 时长、RMS 和 peak，但不验证并发、打断、队列上限或播放顺序（[`smoke_tts.py` L20-L53](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/smoke_tts.py#L20-L53)）。
- 开发日志记录了真实用户试用和若干故障定位，例如回声、重复标签页朗读、上游 Whisper 单 token 崩溃、TTS 取消与 `steer/queue` 验收（[`INTEGRATION_LOG.md` L14-L36](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/docs/INTEGRATION_LOG.md#L14-L36)、[`L173-L185`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/docs/INTEGRATION_LOG.md#L173-L185)），可作为问题清单，但这些记录没有固定语料、设备矩阵或可重放指标，不能外推为声学准确率或跨平台结论。

因此，下文把“代码中确实存在的机制”和“日志宣称的体验结果”严格分开。对元元桌宠的建议也优先复用现有不变量，而不是替换现有内核。

## 项目架构速览

目标项目不是完整的 AI 伴侣运行时，而是 DeepSeek Harness 的语音插件加本地 Python 桥：

```text
DSH Web 插件
  MicRecorder -> POST /api/stt -> DSH session.prompt(steer | queue)
  DSH 流式文本 -> 分句 -> POST /api/tts -> ReplySpeaker FIFO
  ReplySpeaker.speaking -> 陪伴视频 idle/speaking 切换
                         |
                         v
FastAPI voice_bridge (127.0.0.1:8765)
  WhisperSTTHandler + Qwen3TTSHandler + 静态媒体目录
```

README 对这条链路和目录职责给出了同样的边界（[`README.md` L10-L45](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L10-L45)）。桥接源码也明确声明不启动上游 `VAD -> STT -> LLM -> TTS` 总管线，只实例化 STT/TTS，LLM 继续由 DSH 负责（[`voice_bridge.py` L1-L7](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L1-L7)）。

这和元元桌宠的本地/CosyVoice级联方向相似，但目标项目只有 HTTP 整句 STT/TTS；它没有 `managed-v1` 音频身份、generation + segment、候选回执、可恢复 Worklet 环、播放衍生历史或主动陪聊能力。

## 值得借鉴

### 1. 用窄接口拆开语音 UI 的职责

目标插件的 `VoiceInjected` 只暴露 `sendText`、共享 `speaker`、陪伴视图控制器、TTS abort 和打断注册等行为（[`contract.ts` L11-L45](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/contract.ts#L11-L45)）。入口只创建一份 `ReplySpeaker` 和 `CompanionController`，再把麦克风、朗读开关、投递策略、回复监听和陪伴窗口注册为独立组件（[`index.ts` L45-L65](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/index.ts#L45-L65)、[`L117-L188`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/index.ts#L117-L188)）。

元元桌宠目前把传输、协商、麦克风、候选打断、播放、segment ledger、Memory 请求、主动话题和诊断协调集中在 `src/ai/realtime.js` 的一个 `RealtimeSession` 中。建议借鉴的是**接口形状**而不是目标代码：

- `RealtimeTransport`：WebSocket、能力协商、固定消息校验；
- `MicCapture`：权限、Worklet 生命周期、16k PCM；
- `ManagedPlayback`：KXAU、segment ledger、candidate snapshot、完成回执；
- `TurnCoordinator`：candidate/confirmed/rejected、generation 和 continuation；
- `RealtimePolicy`：主动陪聊、Memory/近期话题和对话节奏。

第一阶段只移动代码并保留所有现有事件和测试，不重设协议常量。收益是让未来的打断策略实验不再同时触碰 transport、播放账本和主动对话状态。

### 2. 区分声学停播与语义投递策略

目标项目有一个用户可见的 `interrupt/queue` 开关：当前 DSH 回合运行时，识别文本要么用 `steer` 打断当前生成，要么用 `queue` 等当前回合结束后自动发送（[`index.ts` L67-L90](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/index.ts#L67-L90)）。`BusyToggle` 进一步明确：这个开关只决定文本投递，麦克风检测到插话时停止播放的行为在两种模式都存在（[`BusyToggle.tsx` L1-L13](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/BusyToggle.tsx#L1-L13)）。

这个概念值得元元桌宠吸收。当前本地/CosyVoice 链路在最终 ASR 确认后通常同时停止旧播放、取消旧 response generation 并启动新回复。可以在真实设备数据足够后实验一个固定枚举：

- `interrupt`：保持当前行为；
- `finish-then-answer`：candidate 仍立即让声，但确认后保留当前**已经可听且仍有价值**的有限尾段，再处理新回合；
- 不提供任意毫秒或动态模型决定，避免破坏现有确定性。

但不能直接复制目标实现。它在 queue 模式仍会清空正在播放的回复，却让后台生成继续并把新文本排队，用户可能既听不到旧回复，又要等旧生成完成。这是“音频策略”和“生成策略”分开后的反例，元元桌宠若实验必须先定义四种状态的组合语义和可听历史规则。

### 3. 单项健康检查与用户可执行的语音自检

目标桥的 `/api/health` 分别报告服务是否可达、STT/TTS 是否已加载，以及各自错误（[`voice_bridge.py` L235-L245](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L235-L245)）。README 把验证顺序写成“先启动桥 -> 看 health -> 单独跑 TTS smoke -> 再安装插件”（[`README.md` L231-L257](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L231-L257)），并提前列出磁盘与硬件成本（[`README.md` L54-L65](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L54-L65)、[`L112-L120`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L112-L120)）。

元元桌宠已有 App 托管进程、`kxyy-voice` health 身份、固定状态枚举、安装进度净化和真实 runtime smoke，底层无需改成 FastAPI。可借鉴的是用户路径：在设置页增加“语音自检”，按当前后端依次显示固定结果：

1. runtime / GPU 兼容性；
2. 服务身份与模型就绪；
3. 参考音频与 preset 是否有效；
4. 生成一条固定短 TTS 并播放；
5. 可选录制 3 秒并只在本机回显 final ASR，默认不保存。

输出继续使用固定枚举和计时，不显示路径、原始异常、转录日志或密钥。这个切片主要改善 Windows 首装、模型下载和“服务正常但没声音”的定位效率。

### 4. 防御性 TTS 文本清理

目标项目在朗读前删除 fenced code、inline code、URL、Markdown 标题/引用/列表/强调标记，压缩空白，并在句界附近做软截断（[`clean.ts` L11-L49](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/clean.ts#L11-L49)）。回复监听只取 assistant 的 `text` block，排除 reasoning、tool call 和 image，再对完整句做 TTS（[`reply-listener.tsx` L37-L49](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/reply-listener.tsx#L37-L49)）。

元元桌宠的 `textForSpeech` 已删除括号动作提示、保留语调标点并限制单块长度，但没有同等完整的 Markdown/URL 过滤。建议把这些规则放进现有 `textForSpeech` / Python `text_for_speech` 的共享表格测试，前端文字朗读和本地实时 TTS 同步修改。不要直接复制几个正则后让两端漂移；也不要清理显示文本或 Memory，只清理临时 TTS 输入。

### 5. 把声学状态映射成可替换的视觉状态

目标陪伴窗口只订阅 `speaker.speaking`，空闲与说话视频分层，状态变化时切换；媒体列表变化才更新 React state，避免每 30 秒轮询都重启当前视频（[`companion.tsx` L72-L107](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/companion.tsx#L72-L107)、[`L118-L139`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/companion.tsx#L118-L139)）。

元元桌宠已经通过 `pet-chat` 的 thinking/speaking/reply/interrupt 事件驱动宠物动画，因此“说话态联动”本身无需再借。仍可吸收一个较小的扩展点：让每张 persona card 可声明经过 allow-list 校验的 `idle/thinking/speaking/listening` 动作映射，而不是在语音代码里知道具体动画。它应继续走加密卡片和固定宠物 frame contract，不引入任意目录轮询或第三方写文件。

## 本项目已有，毋需再借

### 实时语音与打断

- 目标项目只有固定 RMS 阈值：普通语音约 `0.01`，播报中约 `0.03` 持续 250 ms（[`recorder.ts` L14-L38](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L14-L38)）；达到阈值后立即离开 interrupt mode（[`L160-L181`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L160-L181)）。元元桌宠已有 candidate/confirmed/rejected 两阶段让声、soft-end/reopen、最终 ASR 校验、candidate snapshot、误打断恢复和可选 Silero shadow；目标方案是明显降级。
- 目标项目的 TTS 所谓“流式”是**文本按句流入，但每句音频整段返回**：服务端遍历 provider chunks 后先拼成一个 WAV 再响应（[`voice_bridge.py` L272-L329](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L272-L329)）。元元桌宠已有 provider PCM、有限 startup reservoir、1x pacing、KXAU identity 和 Worklet ring，不应退回整句 WAV。
- 目标项目只用一个前端 generation 计数阻止被 stop 的旧 WAV 开始播放（[`speaker.ts` L68-L108](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/speaker.ts#L68-L108)），没有 generation + segment 身份、严格序号、完成回执或“只有实际播完才进入历史”。元元桌宠的现有账本不能被这个简化替代。

### 角色、记忆与对话体验

目标桥明确把 LLM 留给 DSH，自身源码没有 persona、关系状态、长期记忆、来源、删除或召回协议。项目名里的“AI 女友”主要体现为 UI、克隆音色和陪伴视频，不构成角色治理或 Memory 方案。元元桌宠应继续以 [`roadmap-ai-roleplay.md`](./roadmap-ai-roleplay.md) 和 [`roadmap-memory-brain.md`](./roadmap-memory-brain.md) 为权威，不从目标项目引入 `localStorage` 式角色/记忆状态。

### 可观测性与验证

目标项目有 health、INFO 日志和两个 smoke 脚本，但没有诊断 schema、事件上限、id 别名、文本隔离、回放测试或多平台 CI。元元桌宠已有隐私安全的 realtime trace、VAD shadow 聚合、JS/Python/Rust 确定性测试和设备验收清单；可以补自检 UI，但不应改用目标项目的日志范式。

## 不可照搬及原因

| 目标实现 | 风险 | 元元桌宠的处理 |
| --- | --- | --- |
| `MicRecorder.chunks` 从开麦就持续 `push`，只有成句/停止才清空（[`recorder.ts` L40-L54](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L40-L54)、[`L195-L223`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L195-L223)） | 用户长时间静音时，语音尚未开始也会无限积累 PCM；`maxUtteranceMs` 只在首次越过阈值后启动 | 保持帧级处理和固定 60 秒成句上限；所有 pre-roll、candidate 和 PCM 队列必须有固定容量 |
| `MicButton.queueRef` 无容量上限，识别串行 drain（[`MicButton.tsx` L40-L44](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/MicButton.tsx#L40-L44)、[`L66-L88`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/MicButton.tsx#L66-L88)、[`L117-L120`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/MicButton.tsx#L117-L120)） | ASR 变慢时，用户可持续产生 30 秒 ArrayBuffer，内存和过时消息都无界增长 | 保持 admission=1、有界 pending 和 generation 丢弃；过载要给固定状态而非静默堆积 |
| `ReplySpeaker.queue` 与 `reply-listener` Promise chain 无界（[`speaker.ts` L12-L18](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/speaker.ts#L12-L18)、[`reply-listener.tsx` L69-L77](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/reply-listener.tsx#L69-L77)、[`L150-L171`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/reply-listener.tsx#L150-L171)） | 长回复或消费变慢会积压整段 WAV；没有 backpressure、最大排队音频或 overflow 语义 | 保持 Worklet 3 秒容量、64 项 ledger、有限句队列和单路播放；不要用 `decodeAudioData` FIFO 替换 |
| interrupt mode 在确认前丢弃所有音频块，250 ms 后才重新开始累积（[`recorder.ts` L74-L79](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L74-L79)、[`L163-L178`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/src/client/voice/recorder.ts#L163-L178)） | 用户首字/首音节会丢失，ASR 可能截头；代码注释“用户正在说的话成为下一句”并不等于保留完整起音 | 保持候选旁路采集和有界 pre-roll，不因让声丢掉候选音频 |
| 一个 `infer_lock` 串行化所有 STT 与 TTS（[`voice_bridge.py` L93-L109](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L93-L109)） | 长 TTS 占锁时 final ASR 无法运行；取消只能等生成器下一个 chunk 边界，打断延迟取决于 provider | 继续使用分池、独立 admission、CancelScope 和每个阻塞边界复检；共享 GPU 时显式定义优先级与不可杀 Future 的 drain |
| loopback HTTP 只靠 CORS origin，允许所有 methods/headers，STT 上限还可由请求头扩大（[`voice_bridge.py` L82-L90](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L82-L90)、[`L248-L264`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L248-L264)） | CORS 不是本机进程鉴权；任意本地客户端可占用昂贵 GPU，且可先 `request.body()` 再做时长检查 | 保持 `KXYY_TTS_SECRET`、strict loopback、服务身份、固定请求上限和浏览器不可见的内部 secret；在读完整 body 前执行大小限制 |
| health 暴露拼接后的原始异常，服务端也 `logger.exception`（[`voice_bridge.py` L127-L155](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L127-L155)） | 异常可能含绝对路径、环境、provider 信息；不符合本项目诊断隐私边界 | 只保留 allow-list 状态、阶段和固定 reason；完整原始异常不进前端事件或复制诊断 |
| 首次模型加载异常被缓存，后续请求始终 503；TTS 取消只在 provider 产出下一个 chunk 后检查（[`voice_bridge.py` L127-L155](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L127-L155)、[`L312-L329`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L312-L329)） | 暂态下载/显存错误必须重启才能恢复；阻塞中的 generator `next()` 不能被 HTTP disconnect 强杀 | 保持可重试生命周期、实际 Future 完成后再释放 admission，以及每个 return/send 边界复检 CancelScope；不要承诺“立即取消” |
| 每 30 秒扫描并公开本地媒体目录，建议第三方 API 直接写目录（[`voice_bridge.py` L344-L387](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/voice_bridge.py#L344-L387)、[`assets/task-videos/README.md` L13-L27](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/assets/task-videos/README.md#L13-L27)） | 未定义文件大小、总量、原子写入、解码失败、来源授权、恶意媒体或磁盘增长边界 | 若未来支持自定义动画，走 App-data staging、扩展名+magic+大小/hash allow-list、原子发布和总容量；第三方不能直接写打包资源 |

## 角色、记忆、部署与可观测性专项判断

### 角色与记忆

没有可迁移实现。目标项目的角色感来自自备克隆音色和视频，并没有 persona corpus、记忆 schema、关系投影或用户可见管理。唯一可借的是架构原则：语音桥不复制 LLM/角色逻辑。元元桌宠已经通过前端 `buildSystemPrompt`、本地代理和 Memory v3 实现这点，应继续保持 persona/Memory 由权威模块组装，语音后端只消费有界上下文。

### 部署

目标项目的优点是文档明确：Windows/NVIDIA/16GB 建议、磁盘估算、模型来源、参考音要求、health、smoke 和常见问题都在一条路径上（[`README.md` L49-L120](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L49-L120)、[`L294-L322`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/README.md#L294-L322)）。缺点是依赖只有 `speech-to-speech==0.2.10` 固定版本，FastAPI、uvicorn、soundfile 均浮动（[`requirements.txt` L1-L8](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/requirements.txt#L1-L8)）；启动器 health 等待 30 秒后即使失败也继续启动 Web（[`start-all.cmd` L26-L47](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/bridge/start-all.cmd#L26-L47)）。元元桌宠只应借其“新手闭环”，不应借浮动依赖或进程启动策略。

### 可观测性

目标项目把 readiness 分成 STT/TTS 两项、日志记录字符数/音频时长、smoke 计算 RMS/peak，这些指标易懂。元元桌宠可在设置页自检中显示同类**有界数值**，但不应把它们加入通话诊断文本，也不应据此宣称音质或准确率。现有 schema v9 的事件净化、id 别名、VAD/句段连续性聚合和延迟 summary 更适合正式诊断。

## 许可证与素材边界

目标仓库的根 `LICENSE` 声称 Apache-2.0，同时说明桥接改编自 HuggingFace speech-to-speech、插件结构来自 MIT 的 deepseek-harness，并警告 AI 媒体在商业再分发前需核查来源（[`LICENSE` L1-L15](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/LICENSE#L1-L15)）。但插件自己的 `package.json` 又标记为 MIT（[`package.json` L42-L52](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/55b6a0a010d73b11120c7d69f754f6f9d92bef99/dsh-plugin/package.json#L42-L52)），根许可证文件也不是完整 Apache-2.0 正文。

结论：可以吸收思想和重新实现小型规则；在复制任何源码或媒体前，必须逐文件确认上游来源、修改许可和素材生成/分发权。尤其不要把 `assets/bg-images` 或示例“女友”媒体同步进元元桌宠。

## 按收益/成本排序的实施建议

| 优先级 | 建议 | 预期收益 | 成本/风险 | 验收门槛 |
| --- | --- | --- | --- | --- |
| P0 | 补齐统一 TTS 文本清理：code fence、inline code、URL、Markdown 标记；JS/Python 镜像规则 | 避免朗读代码、链接和结构噪音；实现面小 | 低；要防止误删正常口语 | 表格测试覆盖中英标点、动作提示、Markdown、URL、空结果和长度边界；显示文本/Memory 不变 |
| P1 | 设置页增加本地语音自检：runtime -> health -> 固定 TTS -> 可选本地 ASR | 大幅降低首装和设备定位成本，尤其 Windows CUDA/音频输出问题 | 中；需要严格隐私状态和取消/超时 | 不记录 PCM/转录/路径；固定 reason；关窗/换后端代际隔离；真实 macOS/Windows 验收 |
| P1 | 先做无行为变化的 `RealtimeSession` 模块拆分 | 降低后续策略与协议变更风险，提高测试定位速度 | 中高；重构 blast radius 大 | 现有 JS/Python/Rust 测试全过；trace、KXAU、generation、回执字节级/事件级不变；小提交迁移 |
| P2 | 设计 `overlapPolicy=interrupt|finish-then-answer` 的本地/CosyVoice 原型 | 给不喜欢被立即截断的用户可控节奏，可能改善连续陪聊 | 中高；可听历史、主动计时、尾段语义复杂 | 默认保持 `interrupt`；固定枚举；至少覆盖候选误触、确认、TTS 已 admission、短尾段、挂断和旧服务回退；真人设备 A/B 后再发布 |
| P3 | persona card 的固定视觉状态映射 | 让不同角色在 listening/thinking/speaking 时更有差异 | 中；涉及卡片同步和资源校验 | 仅 allow-list 动作；缺失时回退现有动画；不开放任意路径和动态目录写入 |
| 不做 | 迁移目标仓库 RMS-only VAD、HTTP WAV FIFO、无界 queue、单 infer lock、媒体目录轮询 | 无新增收益，且会破坏现有正确性/隐私边界 | 高风险 | 不进入路线图 |

## 建议的最小落地顺序

1. **一份小改动**：统一 TTS 文本清理与表格测试，不触碰 realtime 协议。
2. **一个用户功能**：在现有 settings/voice-service 状态之上做语音自检，不新建第三套服务。
3. **一组纯重构提交**：按 transport/capture/playback/coordinator/policy 拆 `RealtimeSession`，每次提交只迁移一个职责，保持事件快照不变。
4. **一个受控原型**：最后再评估 overlap policy；没有真实设备数据前不改变默认打断行为，也不接 Volcano。

整体判断：目标项目提供了一个很好的“把语音能力快速嵌入既有 agent UI”的最小样本。元元桌宠应借它的边界清晰、用户开关和安装自检思路；核心实时链路、记忆、隐私和可靠性则应坚持现有更严格的设计。

## 验证范围

- 本次克隆并固定检查 `55b6a0a010d73b11120c7d69f754f6f9d92bef99`，阅读了 47 个 tracked files 的源码、配置、README、开发日志、许可证和 4 次提交历史。
- 没有安装约数 GB 的 CUDA、Whisper、Qwen3-TTS 与 DSH 宿主，也没有运行目标项目。目标仓库没有可直接执行的确定性 test/spec 或 CI 配置，因此 README/开发日志中的 TTFA、RTF 和“用户验证通过”只作为作者一手陈述，不作为本报告独立复现的性能事实。
- 本次只新增研究文档，没有修改元元桌宠代码、配置或资源，因此没有运行本项目测试套件。

## 2026-08-26 复核：macOS、数字人窗口与 QQ 链路

本节针对用户关心的两个问题，重新检查仓库当前 `main`（`9922b13f5f2fccec394ab0ea497e3fe6599f96c6`）。链接中的行号均指向该提交。

### macOS 支持结论：没有上游支持证据，按不支持处理

- README 的安装章节明确写“全程在 Windows 上操作”，系统要求是 Windows 10/11 64 位，硬件要求 NVIDIA 独立显卡；没有 macOS 安装、启动或验收步骤（[`README.md` L71-L86](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L71-L86)）。
- 数字人部署只给 Windows Docker Desktop/Windows 路径映射（`d:/duix_avatar_data/face2face`），Compose 声明 NVIDIA GPU reservation，并使用 `guiji2025/duix.avatar-5090:trt10.9` 镜像（[`bridge/docker-compose-5060ti.yml` L1-L50](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/bridge/docker-compose-5060ti.yml#L1-L50)）。这不是 macOS/Apple Silicon 的可运行矩阵。
- 启动脚本是 `.cmd`，默认调用 `venv-speech\\Scripts\\python.exe`、PowerShell 和 NapCat Windows launcher（[`bridge/start-bridge.cmd`](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/bridge/start-bridge.cmd)、[`README.md` L350-L360](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L350-L360)）。Python/FastAPI 本身跨平台，但这不等于整套依赖（DUIX、CUDA、NapCat）跨平台。

因此，不能把它称为“支持 macOS”。在 macOS 上最多可移植不含 DUIX/NapCat 的 Python 语音桥和浏览器插件，需另行验证 PyTorch/模型与音频设备；数字人和 QQ 部分没有作者提供的 macOS 路径或测试结果。

### 数字人窗口与性能：实现方式及可相信的上限

数字人窗口不是原生桌面窗口或 3D 渲染，而是 DSH 浏览器页面中的右侧 Companion 列：空闲/说话视频用 HTML `<video>` 播放，列宽（约 240 px 至 70vw）和左右位置写入 `localStorage`，只有拖拽手柄接收指针事件（[`dsh-plugin/src/client/voice/companion.tsx` L1-L24](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/dsh-plugin/src/client/voice/companion.tsx#L1-L24)）。媒体目录初次加载后每 30 秒轮询，仅在列表变化时更新，避免无变化时重启当前视频（[`companion.tsx` L76-L123](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/dsh-plugin/src/client/voice/companion.tsx#L76-L123)）。

开启动画时，文本按默认 48 字分段，逐段 TTS 后提交 DUIX `/easy/submit`；当前段生成期间预合成下一段，DUIX 单任务串行，更新回复会抢占未开始段（[`voice_bridge.py` L781-L858](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/bridge/voice_bridge.py#L781-L858)）。视频生成结果落盘并由 `<video>` 播放，音频已混入视频以保持同步（[`README.md` L300-L337](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L300-L337)）。

性能只有作者自报、不可独立复现的数字：7.3 秒音频由 20.1 秒降到 14.1 秒（约 30%），换 15fps 和关闭超分预计再降；README 同时承认等待主要来自 LLM + 整段 TTS，长回复更慢（[`README.md` L335-L337](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L335-L337)、[`README.md` L403-L409](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L403-L409)）。这说明数字人生成通常慢于实时播放（14.1 秒生成 7.3 秒音频，约 1.9x 音频时长），不能据此宣称低延迟或 macOS 性能。

### QQ：手机可互动消息，但不是实时通话

链路是“手机主号发消息 → 电脑 QQ 小号（NapCat 注入）→ OneBot HTTP/WebSocket → 本地桥 → 浏览器插件 DSH → 文本回复 + TTS Silk 语音消息发回主号”。README 要求 NapCat Windows Shell、登录小号、OneBot HTTP `:3000` 和 WebSocket 客户端连 `ws://127.0.0.1:8765/api/qq/onebot`（[`README.md` L363-L400](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L363-L400)）。

源码只处理 OneBot `post_type=message` 且 `message_type=private` 的文本字段，并把 `{type:"qq_message", text}` 推给插件；插件收到后调用 `sendText`。出站则监听已结算 assistant 文本，发送 `{type:"reply"}`，桥接依次调用 `send_private_msg` 发文本和 Silk `record` 语音（[`voice_bridge.py` L1291-L1389](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/bridge/voice_bridge.py#L1291-L1389)、[`qq_bridge.py` L1-L72](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/bridge/qq_bridge.py#L1-L72)、[`qq-bridge.tsx` L1-L75](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/dsh-plugin/src/client/voice/qq-bridge.tsx#L1-L75)）。没有 `get/friend call`、音频 RTP、QQ 通话事件、实时双工音频或入站语音转写；README 还明确说 QQ 语音必须是 Silk，且回复延迟主要来自 LLM + 整段 TTS（[`README.md` L403-L409](https://github.com/beiyege-01/dsh-voice-ai-girlfriend/blob/9922b13f5fccec394ab0ea497e3fe6599f96c6/README.md#L403-L409)）。

所以用户理解中的“手机上和本机 QQ 互动消息”是成立的（文本与语音**消息**），但“实时通话”不成立；它是回合式异步消息，不是 QQ 语音通话桥。

### 接入当前 Tauri 项目的可行性

**可行但应拆成两项，且不应直接移植目标项目运行时：**

1. **数字人窗口（中等可行性，macOS 低可行性）**：当前项目已有 Tauri 透明置顶宠物窗口、语音播放回执和跨平台窗口管理。可把 DUIX 结果作为受信任的、尺寸/格式/hash 限制的短视频资源，在现有 chat/pet 窗口中播放；但必须新增外部数字人服务生命周期、任务取消、磁盘配额和视频解码验收。DUIX 的 CUDA/NVIDIA Docker 依赖不能作为 macOS 功能；macOS 需另一个 Apple Silicon/Core ML/远程 GPU 后端，或仅保留现有 2D 宠物动画。
2. **QQ 消息桥（Windows 优先，中等可行性）**：可在 Rust loopback proxy 外新增受鉴权的 OneBot/NapCat adapter，把入站私聊文本映射到现有 `chat`/Memory 边界，出站发送文本或已生成的语音消息。必须保留 `KXYY_TTS_SECRET`、严格 loopback、固定大小/频率上限和隐私诊断；不能让 NapCat 事件绕过现有 persona/Memory。该适配器依赖 Windows QQ 注入和小号，macOS 没有上游支持证据。
3. **QQ 实时通话（不可直接接入）**：目标仓库没有通话协议或可复用实现。若产品确实需要手机 QQ 实时通话，需独立研究 QQ/NapCat 是否公开稳定的通话音频 API，并重新设计鉴权、双工 PCM、回声消除、断线恢复和平台合规；在获得一手协议和可运行原型前，不应把它写入当前项目路线图或声称可行。

总体建议：优先实现“QQ 文本 + 语音消息”受控 adapter（仅 Windows、显式开关），数字人先做本地短视频播放原型并以现有 Worklet/回执为准；不要把 DUIX 的 Windows/NVIDIA 方案当作 macOS 支持，也不要把 QQ 语音消息误称为实时通话。
