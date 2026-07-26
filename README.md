# 元元桌宠 (kxyy-desktop-pet)

基于 [webmeji](https://github.com/lars-rooij/webmeji) 动画逻辑改造的 **macOS / Windows 跨平台桌面宠物**，用 **[Tauri](https://tauri.app) 2** 封装（前端 Web 动画 + Rust 主进程）。桌宠会在屏幕上走动、坐下、跳舞、攀爬屏幕边缘，可拖拽、可抚摸，右键或托盘可切换形象。

除动画外，还内置 **AI 聊天** 能力：通过全局快捷键唤出聊天气泡，与「元元」对话（DeepSeek 文字模型，也可切换本地 Ollama 模型离线使用），支持发图看图（通义千问 VL）、语音朗读与**实时语音通话**（可切换火山云端 / 本地模型 / CosyVoice）、表情包回复、自定义人设，以及本地 SQLite **Memory v3 长期记忆**。朗读与通话共用一套语音后端，并支持 **0–200% 播放音量**。所有 AI 服务 Key 和长期记忆只保存在本机，请求经内置本地代理直连服务商或本机模型，不经第三方。

当前内置两套形象：**赛博元元**（`kxyy-cyber`）与 **苗疆元元**（`kxyy-miaojiang`，默认）。应用图标为苗疆元元头部特写，缩小后仍可辨认。macOS 上为菜单栏托盘应用，**不占用 Dock**。

> 相比早期 Electron 版本：安装包由 ~70MB 降至 **~4MB**，内存占用大幅下降（Tauri 复用系统 WebView，无独立 Chromium）。

## 环境要求

- [Node.js](https://nodejs.org)（用于 Tauri CLI）
- [Rust](https://www.rust-lang.org/tools/install)（`rustc` / `cargo`）
- 平台依赖：
  - **Windows**：WebView2 运行时（Win10/11 一般自带）+ MSVC 生成工具
  - **macOS**：Xcode Command Line Tools
- AI 聊天所需的服务 Key（可选，不填也能正常使用桌宠动画）：
  - **DeepSeek API Key**：使用 DeepSeek 文字服务时填写；若文字服务切到本地 Ollama，文字聊天和本地语音对话均不需要该 Key（[申请](https://platform.deepseek.com)）。
  - **通义千问 / DashScope Key**：发图看图、CosyVoice（通义云）选填（[申请](https://bailian.console.aliyun.com)）。
  - **火山引擎**（语音后端选「火山」时）：TTS Key、实时语音 App ID / Access Key、音色 `voice_id`。
  - **本地语音**：需本机 Python 环境；macOS 选 Qwen3-TTS 时应用会自动配置运行时；Windows / Linux 选本地 Qwen3-TTS 走 PyTorch（运行 `scripts/windows/setup-qwen3-tts.cmd` 配置 `.venv-qwen3`）。本地克隆需提供 10–20s 参考音频。
  - **本地文字模型（离线可用）**：设置里「文字服务商」切到「本地模型」需先安装 [Ollama](https://ollama.com/download)（Windows / macOS 均可，5080 / M4 Pro 由 Ollama 自动调用 CUDA / Metal 加速），保存后应用会自动探测并尝试拉起 Ollama 服务，再在设置里点「下载 / 更新模型」拉取模型（默认推荐 `qwen3:14b`，也可填 `qwen3:8b` / `qwen3:32b` 等任意 tag）。
  - 首次实时通话需允许麦克风权限。

## 运行

```bash
npm install
npm run dev        # 开发模式（tauri dev）
```

启动后桌宠出现在屏幕底部，**菜单栏（macOS）/ 系统托盘（Windows）**会出现一个图标（macOS 不显示 Dock 图标）：

- **显示 / 隐藏桌宠**
- **聊天（Ctrl+Shift+Space）**：唤出 / 收起 AI 聊天气泡
- **选择形象**：赛博元元 / 苗疆元元
- **大小**：100% / 125% / 150% / 200%
- **所在屏幕**：多显示器时可选择固定在某块屏幕，或设为「自动（当前屏幕）」跟随启动时所在屏幕
- **设置…**：打开聊天设置窗口（Key、语音后端、模型、人设、头像、快捷键、气泡尺寸、音量等）
- **开机自启**
- **退出**

也可以直接**右键点击桌宠**弹出同样的菜单。桌宠之外的区域鼠标可正常穿透，不影响操作其它软件。

## 交互

- **拖拽**：按住桌宠拖动，松手后它会掉落到屏幕底部。
- **抚摸**：鼠标悬停在桌宠上会触发抚摸动画。
- **自动行为**：走路、坐、旋转、跳舞、思考，以及跳到屏幕左/右/上边缘攀爬、悬挂、坠落。

> 点击穿透说明：Tauri 没有 Electron 的「鼠标事件转发」，故穿透态下由前端低频轮询光标坐标做像素级命中判定，仅当指针接近桌宠时才切回可交互态，桌宠外的透明区域始终穿透。

## AI 聊天

按 **`Ctrl+Shift+Space`**（可在设置中改）或点托盘「聊天」，在桌宠上方唤出聊天气泡，与「元元」对话；再按一次或点窗口外收起。

- **文字对话**：默认由 DeepSeek 驱动，支持流式输出；0.2.29 使用当前 `deepseek-v4-flash` / `deepseek-v4-pro`，并用独立的思考开关控制 `thinking.type`。旧 `deepseek-chat` / `deepseek-reasoner` 设置会在本地安全迁移，未知模型不会原样上送。也可在「文字服务商」切到**本地模型（Ollama）**离线对话（无网络时兜底），需先安装 Ollama 并下载模型；设置里的「思考模式」对本地 Qwen3 同样生效（关=`reasoning_effort: none`，开=`medium`，并自动加大 `max_tokens`）。
- **发图看图**：附带图片时用通义千问 VL 识图（需填通义 Key）。
- **语音朗读 / 实时通话**：朗读与通话共用「语音后端」，在设置里切换：
  | 后端 | 类型 | 说明 |
  | --- | --- | --- |
  | **火山引擎（云端）** | 在线 | 云端 TTS + 端到端实时语音；需火山 Key / App ID / Access Key / `voice_id` |
  | **CosyVoice（通义云端）** | 在线 | 本机 Whisper + 当前文字服务（DeepSeek/Ollama），TTS 走通义云端；需通义 Key 与 CosyVoice 音色 id |
  | **Qwen3-TTS（本地）** | 本地 | 跨平台：macOS(Apple Silicon) 走 mlx-audio（保存后自动配置）；Windows / Linux 走官方 PyTorch 包 `qwen-tts`（默认 1.7B，运行 `scripts/windows/setup-qwen3-tts.cmd` 配置）。零样本克隆参考音频，不消耗火山 token |
- **播放音量**：设置里「AI 语音播放音量」0–200%（100% 为原音量），朗读与通话共用。
- **本地通话识别（0.2.30 实验）**：Qwen3-TTS / CosyVoice 可在设置中把句尾 final ASR 从默认 Whisper 切到 SenseVoiceSmall INT8。SenseVoice runtime 与模型只在明确点击安装后下载到 App 独立数据目录；未安装、校验失败或当前 Python/平台不受支持时，本次语音服务启动固定回退 Whisper，不会逐轮切换或双跑。它仍是整句识别，不改变 RMS/VAD、endpoint 或快速打断，也尚未通过固定许可录音集证明准确率优于 Whisper。火山端到端实时语音不受影响。
- **本地通话断句（0.2.31）**：Qwen3-TTS / CosyVoice 可选「说话停顿容忍度」：快速约 1.05 秒、标准约 1.65 秒（默认）、长停顿约 2.25 秒。它只决定 RMS soft-end 后还能续说多久，标准档减少中文思考停顿被拆成两轮的情况，但正常回复也会相应晚一些开始；火山端到端实时语音不受影响。
- **未播音续说（0.2.32）**：本地/CosyVoice 在第一版回复仍处于 LLM 出字、尚未取得任何 TTS admission 时，若 8 秒内确认用户继续补充，会取消旧 generation、撤回未播的临时助手气泡，并让下一次 LLM 结合上一条用户消息只回答一次。一旦旧回复已开始 TTS admission、超时或不是确认人声，就严格走原有新轮/打断路径；不会撤回已播放内容，也不把提示写入历史、摘要或诊断。
- **实时语音通话**：聊天气泡输入框最左侧的电话按钮开启 / 挂断；经本地 WebSocket 桥接上游（火山或本机 Python 服务），复用元元人设与克隆音色，支持打断。本地/CosyVoice 通话按 LLM 稳定句进入 4 项有界队列并严格按句序播放。CosyVoice 自 0.2.21、macOS Apple Silicon 的 MLX Qwen 自 0.2.22 起，可在播放 Worklet + `managed-v1` 上双向协商 `provider-pcm-v1`：provider 生成期音频按最多 80ms 下发，首版固定单路且不预取下一句。Windows/Linux 的官方 `qwen-tts` 当前没有公开音频 iterator，仍按句整段合成；未协商、legacy、旧服务与火山也继续原路径。流式句段只在结束时声明最终 samples/chunks，前端精确校验；失败、取消、错序、超限或总量不符不会产生“已完整播完”回执。0.2.20 的 `candidate-snapshot-v1` 仍只在 Worklet 本地/CosyVoice 上启用：同一 candidate 确认打断且当前句已播放至少 1 秒时，下一轮仅注入一次固定临时提示；它不进入 history、聊天摘要、长期记忆或日志，也不恢复字、音素或部分文本。通话中文字输入、发图与表情库会暂时锁定。macOS 首次使用会弹出麦克风权限提示。
- **实时语音优化路线**：自然打断、流式管线、Qwen3-TTS/CosyVoice/火山情绪能力和 SenseVoice 评估见 [`docs/roadmap-realtime-voice.md`](docs/roadmap-realtime-voice.md)；其中尚未实现的目标不会作为当前功能承诺。
- **Memory v3（当前开发版本）**：长期记忆由 Rust + SQLite 保存为事实、共同经历和约定；聊天前只选择性召回与当前话题相关的少量内容，后台异步巩固，不再把全部历史塞进 prompt。设置页可搜索、筛选、编辑、置顶、兑现或永久删除记忆；数据库或模型不可用时会回退，不阻塞正常聊天。
- **0.2.34 Memory v3.1-E**：实时通话建立前在 120ms 内预加载最多 3 条置顶记忆、未完成约定或当前话题线索；召回失败自动使用原有通话人设提示，不改变音频协议和打断状态机。逐轮 ASR final 记忆仍未开启，见 Memory Brain 路线图 M2。
- **0.2.35 Memory v3.1-F**：新增实时记忆能力门和诊断字段，三条实时语音路径明确协商 `session-start-v1`；未获得动态 context 能力回显时固定显示为 `none`，避免把 ASR final 误当作逐轮记忆支持。应用诊断 schema 升为 v6。
- **0.2.36 Memory v3.1-G**：本地 Qwen/CosyVoice 级联通话在 ASR final 后支持 `turn-final-v1` 记忆协调：后端暂停最多 100ms 等待前端回传当前 generation 的最多 3 条记忆卡片，超时或过期结果自动丢弃；火山端到端仍保持 session-start-only。
- **Memory Brain 路线**：发布验证、实时通话逐轮记忆、Obsidian 式 Memory Graph、Global Workspace/J-Space 类实验和外部工程接入，统一见 [`docs/roadmap-memory-brain.md`](docs/roadmap-memory-brain.md)。未标记为 released 的阶段不作为当前正式版能力承诺。
- **表情包**：元元会按情绪回贴纸；也可点「表情库」手动发送。
- **人设 / 观众画像**：在设置里填昵称、关系、想让它记住的事、暗号梗等，对话时注入，让元元更懂你。

> **隐私**：所有 Key、观众画像、头像、参考音频路径仅写入本机配置目录的 `settings.json`，长期记忆数据库写入同目录的 `memory-v3.sqlite3`（Windows 为 `%APPDATA%\<应用ID>\`），均不进仓库。Memory v3 当前与 `settings.json` 一样是本机明文存储，尚未引入 SQLCipher；数据库、召回结果和统计不作为遥测上传，但在线文字模式会把允许记忆的会话批次直发给当前配置的 DeepSeek 做巩固，本地 Ollama 模式则留在本机。其它聊天、识图和语音请求也由内置本地代理（Rust `api.rs` / `realtime.rs` / `voice_service.rs`）直连相应服务商或本机模型，不经额外第三方。内置人设语料经 XOR 加密后编译进 Rust 二进制，运行时由 `/api/assets` 下发，**安装包内不含明文 `persona-assets.js`**。

### 配置

托盘菜单选 **设置…** 打开设置窗口，按分区填写：AI 服务 Key、语音服务（后端 / 参考音频 / 音量）、模型与人格、观众画像、头像与外观、快捷键与气泡尺寸；“记忆”页可管理当前人设/用户的长期记忆。保存后即时生效（快捷键会重注册、聊天窗口按新尺寸重定位；切换本地语音后端，或修改 CosyVoice Key / 音色 / 模型，会自动启动或重启本机语音服务）。

### 本地语音说明

- **零样本克隆**：本地模型不训练音色，填入 10–20s 单人清晰参考录音（及可选文案）后，**保存并重启语音服务**（切换后端或重开 App）即按此录音克隆。
- **macOS**：Qwen3-TTS 运行时落在 `~/Library/Application Support/com.aaronfang.kxyydesktoppet/voice-runtime`，首次选用本地后端会自动配置，也可手动执行 `scripts/macos/setup-qwen3-tts.sh`。
- **Windows / Linux（本地 Qwen3-TTS）**：走官方 PyTorch 包 `qwen-tts`，默认加载 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（首次运行自动下载，约数 GB）。Windows 运行 `scripts/windows/setup-qwen3-tts.cmd` 会创建独立环境 `scripts/local-realtime/.venv-qwen3` 并安装 torch + qwen-tts 等依赖（脚本按 GPU 自动选 wheel：RTX 50 系/Blackwell 用 `cu128`，其它 NVIDIA 用 `cu124`，无卡则 CPU，较慢；Python 需 3.10–3.13，3.14 暂无 wheel）。可在 `settings.json` 用 `qwen3ModelDir`（本地权重目录或模型 id）、`qwen3Language`（默认 `Auto`）覆盖。
- **CosyVoice 0.2.21 实测重点**：选择 CosyVoice 后接通，观察稳定句开始合成后是否更早出声、长句是否无噪声/变速、连续两句是否严格有序，并在首句中途插话确认旧音频立即停止。公开资料未规范性写明 raw PCM 字节序；若听到白噪声、严重变速或音高异常，请结束通话并保留不含文本/PCM 的 trace，不要继续计费测试。
- **Qwen MLX 0.2.22 实测重点**：在 Apple Silicon 选择本地 Qwen3-TTS，要求一段较长回复，观察首句是否在整句生成完前开始播放、chunk 接缝是否自然，并在首句中途插话确认旧生成在下一个 provider chunk 边界后释放、ASR 能继续运行。旧 `mlx-audio` API、非 24k 模型、Windows/Linux PyTorch、legacy 播放会自动回退整句；没有真实设备 trace 前不宣称 TTFA 或打断 p95 改善。
- **0.2.23 通话诊断**：在设置中勾选“显示聊天界面调试信息”，接通并完成测试轮次后，可在聊天底部点击“复制通话诊断 JSON”（通话中或挂断后均可）。JSON 只含固定协商枚举、重新编号的会话 ID、单调相对时间和有界数值指标，不含 Key、persona、文本、路径或 PCM。先检查 `runtime` 是否为预期的 `worklet + managed-v1 + provider-pcm-v1`，再按 [`docs/roadmap-realtime-voice.md`](docs/roadmap-realtime-voice.md) 2.17 的 runbook 记录 TTFA、接缝与取消恢复；`maxSampledQueuedMs` 是 500ms 采样最高值，`drainInclusiveUnderruns` 包含自然播放结束，二者都不能解释成 provider 内部指标。
- **0.2.24 VAD 回放基础**：仓库新增不依赖账户、麦克风、模型、Torch 或 ONNX Runtime 的 512-sample 组帧、概率迟滞、generation/fallback 和 synthetic-only provenance 测试。它尚未接入本地通话 `Session`，App 仍使用原有 RMS candidate/soft endpoint；此版不能用于比较神经 VAD 听感或准确率。开发验证运行 `npm run test:python`，实现/待实验边界见路线图 2.18。
- **0.2.25 bounded VAD shadow**：本地/CosyVoice `Session` 已具备可注入的 dedicated worker、全进程单 admission 和 queue=1 旁路；溢出会换 epoch，迟到结果不参与状态。发布版尚未带 Silero/ORT，默认诊断 `runtime.vadShadow=disabled`，因此通话仍完全由 RMS 决策、没有神经 VAD 体验变化。诊断报告 schema 升为 v2；下一版才会对支持的运行时启用真实 shadow。
- **0.2.26 真实 Silero shadow（实验、默认关闭）**：安装包内固定携带未经修改的 Silero VAD v6.2.1 `16k/op15` ONNX 模型、MIT 许可证与严格 manifest，但不把 ONNX Runtime 作为默认依赖，也不会静默安装。要测试时先选择 Qwen3-TTS 或 CosyVoice，在设置中勾选“启用实验性神经 VAD shadow”并保存，再点击“安装 / 检查 VAD runtime”；安装器只接受审核过的 64 位 macOS/Windows、CPython 3.10–3.14 组合，按固定 wheel 名称和 SHA-256 下载到 App 自有版本目录，并在发布前执行真实模型推理。语音服务重启后接通电话，诊断中的 `runtime.vadShadow=silero-onnx-shadow-v1` 表示握手时已成功获取真实 scorer 的独占 shadow lease；它不是整通电话持续健康遥测，`warming`、`busy`、`unavailable` 或 `disabled` 也都不是有效模型测试。此版本仍由 RMS 独占 candidate、endpoint 与 ASR 决策，正常听感和打断行为应与 0.2.25 一致；不记录概率、PCM、文本或路径。诊断 schema 为 v3。真实声学回放、live 单调时钟 candidate 上限与阈值验收完成前不得让 Silero 接管线上决策。
- **0.2.27 candidate deadline / 离线评估基础（仍为 shadow）**：纯概率状态机现在要求显式、硬上限的 candidate frame budget；合法当前代 frame 都推进 age，confirmed/rejected 在截止帧优先，只有仍悬空的候选产生内部 `candidate_timeout`。真实 Silero shadow 使用 96 个 512-sample frame（3.072 秒）的机械保护值，它不是线上墙钟承诺或声学阈值结论。新增纯标准库、流式且事务化的离线 evaluator：每次只保留 `<1024 bytes` 组帧余量和有界事件/真值数字，输出固定 aggregate 计数、整数 ppm 与延迟桶，不输出概率序列、PCM、路径、文本、persona 或异常详情。它当前只由合成 PCM / 注入 fake scorer 确定性测试覆盖，未接入 Session，也没有让 Silero 获得 candidate、endpoint、ASR 或播放决策权。
- **0.2.28 shadow 诊断闭环（仍为实验、默认关闭）**：本地/CosyVoice 会把固定、provider-neutral 的 VAD shadow 聚合搭载在原本就要发送的 session / ASR-end 控制消息上，并在挂断时单独发送 final；因此通话中可复制到最新结果，又不会为观测增加会阻塞 RMS/ASR 的额外发送。诊断 JSON schema v4 在 `aggregate.vadShadow` 展示配置 revision、运行状态、queue=1 峰值、offer/drop/process/stale/fault、五类纯状态事件和最多 64 个推理耗时样本的 p50/p95。挂断只短暂等待 final summary，阻塞 scorer 会以 `complete:false` / `outstanding>0` 如实结束。报告不含 epoch、lease token、概率、PCM、文本、persona、路径或异常；旧服务固定显示 `not-reported`。这些数字只证明 shadow 是否实际运行及其机械负载，不能解释为准确率、阈值通过或体验改善，Silero 仍没有 candidate、endpoint、ASR 或播放决策权。
- **0.2.29 对话质量修复**：本地/CosyVoice 通话不再把不足 18 个 Unicode 字符（含标点/神态 cue）的短块立刻拆成独立 voice-clone 请求，而是在下一稳定边界或 LLM 完成时有界合并，减少同一回复内每句重新随机采样造成的音色/韵律漂移；单句短回复因此可能等到文字生成完成才开始播音，40 字 soft 阈值、60 字 buffer ceiling、4 项队列和 60 秒音频上限不变。合并块只有整体播完才进入可听历史，中途打断会保守排除整块。CosyVoice 实时通话（含未协商流式时的 buffered fallback）固定使用参考音 neutral 基线 rate，不再逐稳定块改变 instruction/rate；普通文字朗读仍保留情绪映射。Whisper 两条本地路径关闭跨窗口前文条件，并拒绝超过 512 字或长周期重复的识别结果，专门拦截几十个“乖/乱”等幻觉；短重复强调仍允许。播放仍固定 24kHz，没有做 DSP 变速；Qwen 采样档位、真实 TTFA/音色改善和 ASR 召回率仍须设备试听，不能由纯状态测试推断。
- **0.2.30 SenseVoice final ASR（实验、默认 Whisper）**：选择本地 Qwen3-TTS 或 CosyVoice 后，可选择 SenseVoice 并保存，再点击“安装 / 检查 SenseVoice runtime”。安装器只接受审计过的 64 位 macOS/Windows、CPython 3.10–3.14 组合，按固定文件大小与 SHA-256 下载 `sherpa-onnx 1.13.4` 和 SenseVoiceSmall INT8，并在发布目标前执行真实推理 smoke；模型不随 App 安装包分发。接通后诊断 schema v5 的 `runtime.asr` 应显示 `requested:sensevoice`、`active:sensevoice-sherpa-onnx`、`status:active`；固定回退时为 `status:fallback` 和对应 Whisper 枚举。诊断不含转写文本、标签概率、路径或异常。`sherpa-onnx` runtime 为 Apache-2.0；转换后的模型权重仍受 [FunASR Model License 1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) 约束。macOS wheel 的平台 tag 不等于实际系统兼容承诺，安装 smoke 失败时继续使用 Whisper。
- **0.2.31 断句与音色稳定**：本地/CosyVoice 的停顿容忍度改为固定三档，默认标准档在 480ms soft-end 后保留 1170ms reopen 窗口；设置保存后重启本地语音服务。实时 TTS 的稳定块下限从 18 字提升到 30 字，减少本地 Qwen/Ollama 较碎输出触发多次独立 voice-clone 随机采样；40 字 soft 阈值、60 字硬上限、4 项队列与短回复在 SSE 完成时的立即 flush 不变。此项不固定模型 seed，也不宣称已经完成设备听感或音色相似度验收。
- **0.2.32 未播音回复收敛**：本地/CosyVoice 的旧 response 只有在 active、8 秒内且尚未进入 TTS admission 时，才能给下一请求增加一次固定 continuation hint；若旧助手已经出字，后端发送只含 generation 的 `assistant_discarded`，前端按当前 generation 撤回临时气泡。旧用户消息继续通过现有有界 audible history 提供上下文，不拼接或记录完整转写；提示只存在于单次请求快照。已开始阻塞 TTS 的 Future 不合并，以免旧任务占槽后再次造成新回复无声。火山、Silero、RMS endpoint、Qwen 采样参数和诊断 schema 均不变。
- 设置页底部会显示本地服务状态与日志；开发模式也可直接使用仓库内 `scripts/local-realtime/`。

## 打包

打包前会自动加密人设语料并临时移走明文文件，避免语料原文打进安装包：

```bash
npm run encrypt-assets   # 单独执行：将 persona-assets.js 加密为 src-tauri/assets/persona-assets.enc
npm run build            # 当前平台（含 encrypt → strip → tauri build → restore）
npm run build:win        # Windows 安装包 (NSIS)
npm run build:mac        # macOS dmg
```

产物在 `src-tauri/target/release/bundle/` 目录。

> **开发注意**：`npm run dev` 前也会自动执行 `encrypt-assets`；若 `sync-ai` 后更新了语料，需重新加密。`persona-assets.enc` 已加入 `.gitignore`，CI 与本地打包时现场生成。
>
> 图标：`src-tauri/icons/` 由 `npx tauri icon <方形png>` 生成；仓库 `build/icon-square.png` 为图标源（苗疆元元头部特写）。

## 目录结构

```
src/                  前端（渲染层，随前端一起打包）
  index.html
  styles.css
  pet-config.js       角色配置与注册
  pet-engine.js       动画引擎（源自 webmeji 的 Creature）
  app.js              启动、点击穿透命中判定、右键菜单联动（Tauri IPC）
  assets/pets/        两套角色素材：<角色id>/<动作>/<动作>_NN.png
  chat.html/js/css    AI 聊天气泡窗口（流式对话、图片附件、表情库、实时语音通话、音量）
  settings.html/js/css 设置窗口（Key、语音后端、模型、人设、头像、快捷键、气泡尺寸、音量）
  ai/                 复用自上游的纯逻辑/语料模块
    persona.js        人设与提示词组装（运行时从 /api/assets 拉取语料）
    persona-assets.js 人设语料（开发用明文；打包时加密嵌入，不随安装包分发）
    stickers.js       表情系统（清单加载与情绪匹配）
    tts.js            语音合成（火山 / 本地 / CosyVoice 等后端）
    realtime.js       实时语音通话前端（麦克风采集、下行播放、打断）
    voice-volume.js   朗读与通话共用的播放音量增益
    pcm-worklet.js    麦克风 PCM 重采样 AudioWorklet（16k s16le）
    avatars.js        默认头像
  stickers/           表情包清单 stickers.json + GIF 素材
src-tauri/            Rust 主进程
  src/lib.rs          透明置顶穿透窗口、托盘菜单、开机自启、设置持久化、全局快捷键、聊天/设置窗口管理、IPC 命令；macOS 隐藏 Dock
  src/api.rs          本地 AI 代理：聊天 / TTS / 语料下发（/api/assets）
  src/memory.rs       Memory v3：SQLite schema、巩固队列、事实演化、召回、管理 IPC 与测试
  src/realtime.rs     本地实时语音 WS 桥接（前端 ↔ 火山或本机语音服务）
  src/voice_service.rs 本地 Python 语音服务生命周期（启动 / 重启 / 日志）
  src/persona_assets.rs 人设语料 XOR 解密（编译期嵌入 persona-assets.enc）
  assets/             persona-assets.enc（encrypt-assets 生成，gitignore）
  src/main.rs         入口
  Info.plist          macOS：麦克风用途说明、LSUIElement（隐藏 Dock）
  windows/hooks.nsh   Windows 安装程序钩子（可选 GPU 本地语音配置）
  tauri.conf.json     窗口 / 打包 / 图标配置（含 local-realtime 脚本资源）
  capabilities/       前端权限
  icons/              应用图标
shared/
  roster.json         角色清单（主进程托盘与前端共用，编译期嵌入 Rust）
scripts/
  sync-assets.mjs     从 web 工程同步角色素材到 src/assets/pets
  sync-ai.mjs         从 web 工程同步 AI 逻辑模块、人设语料与表情素材
  encrypt-assets.mjs  将 persona-assets.js 加密为 src-tauri/assets/persona-assets.enc
  bundle-assets.mjs   打包前 strip / 打包后 restore 明文语料文件
  local-realtime/     本地语音 Python 服务（Qwen3-TTS / CosyVoice 等）
  macos/setup-qwen3-tts.sh   macOS Qwen3-TTS 运行时自动配置
  windows/setup-qwen3-tts.*  Windows Qwen3-TTS 本地环境配置
```

## 扩展 / 同步新角色

素材结构与上游 web 工程 (`kxyy_ai_clone`) 完全一致，方便持续扩展：

1. **同步素材**（默认从同级的 `kxyy_ai_clone` web 工程拉取）：
   ```bash
   npm run sync-assets
   # 或指定源目录
   node scripts/sync-assets.mjs /path/to/webmeji
   ```
2. **注册新角色**：
   - 在 `shared/roster.json` 的 `pets` 里加一行 `{ "id": "新id", "label": "显示名" }`。
   - 在 `src/pet-config.js` 用 `registerPet("新id", { frames: {...}, ... })` 配置帧数与节奏（帧数与上游 `config.js` 保持一致即可）。

每个角色需要的动作目录：`walk / sit / dance / trip / forcethink / pet / drag / falling / fallen / climbSide / climbTop / hangstillSide / hangstillTop / jump`。

### 同步 AI 逻辑与表情

AI 的纯逻辑模块（人设、TTS、表情系统）与表情素材同样与上游 web 工程一致，可一键同步：

```bash
npm run sync-ai
# 或指定源目录
node scripts/sync-ai.mjs /path/to/kxyy_ai_clone
```

会把上游的 `persona.js` / `tts.js` / `persona-assets.js` / `stickers.js` 同步到 `src/ai/`，并把表情清单与 GIF 拷到 `src/stickers/`（自动改写为包内相对路径）。同步语料后请执行：

```bash
npm run encrypt-assets
```

> 若上游改动了 `/api/chat` 的请求 / 响应契约，需手动同步更新 `src-tauri/src/api.rs` 与 `src/chat.js`。

## 发布

版本号需在 **`package.json`**、**`src-tauri/tauri.conf.json`**、**`src-tauri/Cargo.toml`**（及 `Cargo.lock`）四处保持一致。`.github/workflows/release.yml` 第一步就是**预校验四处版本号与 tag 一致**——任何一处不对都会让整个 release 直接失败，根除「bump 完忘打 tag」「打 tag 前忘 bump」的旧坑。

### 发布流程

1. **Bump 版本号**：在 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处把版本号同步改成 `X.Y.Z`（`Cargo.lock` 由 `cargo` 自动同步）。
2. **Commit 版本号变更**：`git commit -am "chore(release): vX.Y.Z"`。
3. **推 commit + 推 tag**：`git push` 推 commit，再 `git push origin vX.Y.Z` 推 tag（**只推 tag 不推 commit 不行**——`verify` job 必须能 checkout 到带新版本号的 commit）。
4. **CI 自动完成**：
   - `verify` job（ubuntu）：四处版本号与 tag 比对，不一致立即失败；
   - `release` job（macOS aarch64 / macOS x64 / Windows 三台 runner 并行）：构建 + 签名后产物上传到 GitHub Release 对应 tag 页。

### Changelog：自动生成，零维护

`release.yml` 会从 `git log <prev_tag>..vX.Y.Z` **自动生成 changelog**，按 [Conventional Commits](https://www.conventionalcommits.org/) 类型分桶：

- `feat:` / `feat(scope):` → 归到「新增」段
- `fix:` / `fix(scope):` → 归到「修复」段
- 其余非维护性 commit → 归到「其他」段
- `chore(release):` / `docs:` / `ci:` / `build:` → **跳过**（不出现）
- merge commits 默认排除

完整历史 changelog 见 [GitHub Releases](https://github.com/aaronfang/kxyy-desktop-pet/releases)。

### Commit 规范（影响 changelog 质量）

为了让 auto-generated changelog 读起来像样，commit message 建议遵循 Conventional Commits：

- `feat: xxx` / `feat(scope): xxx` → 进入「新增」段
- `fix: xxx` / `fix(scope): xxx` → 进入「修复」段
- `chore(release): vX.Y.Z` / `docs:` / `ci:` / `build:` → 跳过

### CI 与 Release 的分工

| 触发 | Workflow | 行为 |
|---|---|---|
| `push` 到 main / `pull_request` → main | [`ci.yml`](.github/workflows/ci.yml) | 两平台 build-only 校验（macos-aarch64 + windows-x64），**不发版**；纯文档/纯脚本/纯 `.gitignore` 改动跳过（`paths-ignore`） |
| `push: tags: ['v*']` | [`release.yml`](.github/workflows/release.yml) | 版本号校验 + 三平台（含 macos-x64）构建 + 上传 GitHub Release |

两者互不干扰。可在 GitHub Actions 页面手动 `workflow_dispatch` 重跑 release。

## 致谢

动画引擎源自 Lars de Rooij 的 [webmeji](https://webmeji.neocities.org)。
