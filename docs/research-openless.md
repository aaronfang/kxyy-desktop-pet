# OpenLess 工程研究与对当前工程的借鉴

> 研究对象：`Open-Less/openless`，克隆于 2026-08-31，HEAD `fc9824e`（beta，浅克隆）。本文依据源码、测试和 CI 配置，不以 README 为唯一来源。

## 1. 工程定位与总体思路

OpenLess 是一个 Tauri 2 桌面听写/润色工具：本地 Rust 进程负责全局热键、录音、ASR、LLM 润色、文本插入、持久化和权限；React/TypeScript 负责设置、历史、QA 面板、风格包等 UI。README 所列流水线是 `hotkey edge -> Recorder.start + ASR.openSession -> audio frames -> stop -> Polish -> Insert -> History.save`（`README.md:381-399`），源码中也把这些职责拆成 `coordinator`、`asr`、`polish`、`insertion`、`persistence` 等模块。

核心架构原则是“协调器单一拥有会话状态，外围能力通过窄接口接入”。`coordinator_state.rs` 明确声明纯状态层不依赖 Tauri、音频或剪贴板，因此可以在 Windows CI 中独立运行单元测试（`openless-all/app/src-tauri/src/coordinator_state.rs:1-5`）；`asr/mod.rs` 只向录音器暴露 `AudioConsumer::consume_pcm_chunk`，并以 `RawTranscript` 作为统一结果（`asr/mod.rs:32-45`）。

## 2. 会话状态机与并发竞态处理

`SessionPhase` 包含 `Idle/Starting/Listening/Processing/Inserting`，并把“插入已经不可撤销”的窗口单独建模（`coordinator_state.rs:21-32`）。每次 `begin_session_state` 仅允许 Idle 进入 Starting，并生成新的 UUID；同时清除上一次的取消/停止边沿（`coordinator_state.rs:71-89`）。

启动和取消不是简单布尔值：

- Starting 阶段收到 stop 会记录 `pending_stop`，等 ASR 握手完成后转 Listening 并立即结束（`coordinator_state.rs:92-99,115-131`）。
- 每个异步 continuation 携带 `session_id`；如果 ID 不匹配则判为 `StaleContinuation`，避免上一个会话的迟到回调修改新会话（`coordinator_state.rs:101-123,141-151`）。
- Processing 阶段取消只设置 `cancelled`，由 end_session 在 polish/insert 检查点完成收尾，避免与插入路径竞争；Inserting 阶段拒绝取消，因为 Cmd+V 已无法撤销（`coordinator_state.rs:160-203`）。

这套设计把竞态规则写成纯函数和表驱动测试，而不是散落在异步任务中。对当前工程（也有实时语音、TTS、窗口和生成代际）最值得借鉴的是：为每个可取消工作分配 generation/session token；定义不可逆阶段；在每个 await/发送边界重新验证 token；把状态转移抽到无运行时依赖的纯模块。

## 3. Provider 抽象与运行时选择

ASR 目录按 provider 拆分（Volcengine、Bailian、Qwen3、StepFun、讯飞、Whisper 等），统一通过 trait/结构体接入；本地 ASR 又按平台和引擎拆为 MLX、C、Foundry、sherpa 等（`asr/mod.rs:8-30`；`asr/local/mod.rs:1-22,72-120`）。`qwen_backend_for_provider` 将旧 provider id 映射到明确后端，保留兼容 id（`asr/local/mod.rs:72-120`），并让 `LocalQwenEngine` 只暴露 load、transcribe、cancel、health 等稳定方法（`asr/local/mod.rs:123-180`）。

LLM 侧使用 `OpenAICompatibleConfig`，统一 provider_id、base_url、model、headers、temperature、timeout、thinking 开关（`polish.rs:95-149`），并对内置 provider 施加统一温度策略、对 custom provider 保留用户参数（`polish.rs:151-180`）。流式请求把“首 token 等待”和“出字间隙”拆成两把超时尺子，且首 token 预算按输入长度增长（`polish.rs:41-93`）。

借鉴点：

1. provider 只实现协议适配，业务流程依赖统一 trait/结果类型。
2. provider id 做版本化/兼容映射，避免设置升级破坏旧配置。
3. 将超时按阶段定义（连接、首输出、连续输出、硬上限），不要用单一总超时误杀长思考模型。

## 4. 持久化、迁移与数据安全

持久化层按 history/preferences/dictionary/credentials/style pack 分模块，并通过 `pub use` 保持旧路径兼容（`persistence/mod.rs:16-50`）。跨平台数据目录显式区分 macOS、Windows、Linux、Android，Android 不回退到不可写的 `/data/local/tmp`（`persistence/mod.rs:64-113`）。所有 JSON 写入先写唯一临时文件再 rename，避免并发 writer 相互覆盖（`persistence/mod.rs:120-146`）。

Preferences 解析失败时不会静默恢复默认：先用 `create_new` 备份损坏原文件，再逐字段 salvage 合法值并原子写回（`persistence/preferences.rs:23-56,87-108`）；旧字段迁移会持久化 migration marker（`preferences.rs:59-84`）。凭据策略是写入系统 Keychain/Credential Manager/keyring，旧明文文件仅作为一次迁移来源（`persistence/mod.rs:11-14`）。

当前工程已有加密 persona、SQLite Memory 和 Tauri secrets；可吸收的是“损坏数据可恢复、迁移有 marker、写入原子化、敏感数据与普通设置分离”的工程细节，以及对 Android/多平台路径的显式约束。

## 5. 风格包与扩展机制

StylePackStore 将内置包和 imported 包统一建模，启动时执行迁移、内置版本对账、至少一个启用包约束，并同步 UserPreferences（`persistence/style_pack.rs:29-88`）。激活时自动启用被禁用包、更新 active id；删除 imported 包会同步清理相关快捷键，禁止删除 builtin（`style_pack.rs:146-175,221-291`；`commands/style_packs.rs:200-220`）。ZIP 导入/导出经过独立 archive parser，并有压缩大小上限（`persistence/mod.rs:50-52`）。

这提供了一个成熟的“可扩展人格/提示词包”模式：核心内置默认值可随版本升级覆盖，用户的 enabled 状态保留；第三方包有独立资产目录、来源关系和可撤销生命周期。对当前工程的 persona/voice preset/主题资源，可考虑统一的 manifest、版本、来源、启用状态、资源配额和回滚机制；但不应把外部包内容直接并入 system/persona 规则，仍需保持当前工程的 persona governance 与白名单边界。

## 6. 远程输入的安全与生命周期

远程输入是 Rust 内嵌 HTTPS + WebSocket 服务，H5 资源用 `include_str!/include_bytes!` 编译期嵌入，手机上传 16 kHz mono PCM 后复用本地 Coordinator 管线（`remote_server/mod.rs:1-11,35-42`）。PIN 使用 rejection sampling 生成 6 位码，按 IP 和全局窗口限速，并限制失败表容量；PCM 帧有 64 KiB 上限；WS 通过 30 秒 ping、90 秒 idle timeout 清理半开连接（`remote_server/mod.rs:48-67,117-130`）。

服务句柄同时持有 accept-loop shutdown 和连接级 watch channel；关闭服务会广播到所有已建立连接，避免“设置已关闭但旧手机仍可录音/落字”（`remote_server/mod.rs:78-101`）。自签 TLS 证书按 SAN 持久化复用，换网卡地址时才重新生成（`remote_server/mod.rs:184-212`）。

当前工程已有 loopback realtime bridge；若未来增加局域网控制，可直接借鉴这些边界：认证失败分层限速、帧/队列硬上限、keepalive + idle 回收、关闭时级联取消、证书稳定性和地址快照缓存。

## 7. 前端状态与 IPC 组织

React 页面状态以局部 `useState`/Context 为主（例如 `useAppState.ts` 与 `HotkeySettingsContext`），并没有引入 Recoil；快捷键设置由专门 Context 管理。所有 Rust 调用经 `src/lib/ipc` 分域模块，再由 `ipc/index.ts` barrel 统一导出（`openless-all/app/src/state/useAppState.ts:1-24`；`openless-all/app/src/lib/ipc/index.ts:1-21,80-103`）。每个 IPC 模块提供 `invokeOrMock` fallback，便于非 Tauri 浏览器开发和单测（例如 `openless-all/app/src/lib/ipc/remote-server.ts:1-35`）。

当前工程的多窗口事件很多，可借鉴“按领域拆 IPC、统一 barrel、浏览器 mock 实现”和事件名/载荷类型集中管理，减少 chat/settings/main 窗口之间的漂移。

## 8. 测试与发布工程化

源码中有大量 Rust `#[cfg(test)]`（浅克隆统计约 103 个文件）和前端 `*.test.ts(x)`（约 25 个文件），覆盖状态机、布局、IPC mock、provider 设置、ZIP、markdown 清洗等。CI 将前端行为/契约测试与多平台 `cargo check` 分开，并采用矩阵、`fail-fast: false`；Android 还单独做 JVM 凭据和 emulator instrumentation（`.github/workflows/ci.yml:1-7,168-180`；`android-apk.yml:21-37,135-165`）。Release workflow 对 stable/beta 频道、签名密钥、跨平台产物分别设门禁（`.github/workflows/release-tauri.yml:1-16,29-69,119-136`）。

值得移植到当前工程的做法：

- 将纯状态/协议 parser 测试从 Tauri harness 中剥离，保证 Windows/Linux CI 可运行。
- 前端 IPC 提供 deterministic mock，测试 UI 状态而不依赖真实窗口。
- CI 同时做类型/契约测试、跨平台编译检查和资源/签名门禁；发布频道与更新 manifest 明确隔离。
- 维护版本同步脚本和“干净机器 smoke test”清单，而不是只依赖 build 成功。

## 9. 不宜直接照搬的部分与优先级

OpenLess 的功能面（系统级 accessibility、远程手机录音、Android overlay、众多 ASR provider）比当前工程更宽，部分复杂度来自其产品边界，不应原样移植。当前工程优先级建议为：

1. 立即采用：generation/session token 状态机、不可逆阶段、纯协议/状态测试、原子持久化与损坏恢复、IPC 分域与 mock。
2. 中期采用：persona/style/voice preset 的 manifest + 版本对账 + 来源/资产配额；provider 能力声明和分阶段超时策略。
3. 需要单独评估：局域网远程输入、Android overlay、Marketplace/第三方包分发。它们会显著扩大攻击面和跨平台 E2E 负担。

## 10. 结论

OpenLess 最有价值的不是某个具体 ASR 或 UI，而是把桌面 AI 应用拆成“纯状态转移 + 能力适配器 + 受约束持久化 + 可验证 IPC + 跨平台门禁”。当前工程已经具备类似基础（Rust Tauri、实时会话、Memory、资源加密）；将上述边界进一步固化，可降低异步语音链路中的竞态、旧配置损坏和跨窗口协议漂移风险，同时保持 persona、Memory 和 provider 安全策略不被扩展机制绕过。

## 11. 面向当前工程的落地顺序

下面是按收益/改动面排列的实施顺序，不是把 OpenLess 的功能整体搬过来：

1. **先固化会话纯状态层**：把 `src/ai/realtime.js` 中 generation、candidate、playback receipt、proactive timer 的关键转移继续抽成无 DOM/AudioWorklet 依赖的纯模块；每个异步操作携带 generation，统一在 `await`、WS send、TTS admission、playback receipt 四类边界校验。对应 OpenLess 的 `coordinator_state.rs`，但要保留当前 `managed-v1` 的 segment ledger 与 playback-derived history 规则。
2. **再做 provider capability/timeout 结构**：为 Volcano、local、CosyVoice、Ollama、DeepSeek 等定义能力声明（是否支持 SSE、managed PCM、动态 context、主动生成），把连接/首包/连续包/总时限分开。这样可以避免把 OpenLess 的“多 provider”误变成当前工程的隐式协议分支。
3. **补齐设置与资源的损坏恢复**：沿用 `atomic_write`、损坏文件备份、逐字段 salvage、migration marker；优先覆盖 `settings.json`、voice preset、topic cache 和 persona manifest。Memory SQLite 已有更强的事务/备份机制，不应退回 JSON 全量覆盖。
4. **统一 IPC 领域边界**：将 `src-tauri` commands 与 `src/*.js` 事件按 `realtime`、`memory`、`voice-service`、`settings`、`window` 分域，集中定义 payload schema，并为浏览器测试提供 mock。不要复制 OpenLess 的页面数量，而是减少当前多窗口事件名漂移。
5. **最后评估扩展生态**：如果引入 persona/voice pack，只接受 manifest + schema/version + 来源 + 资源配额 + 回滚；第三方内容只能作为受审计的数据输入，不能覆盖 `buildSystemPrompt`、Memory 权限或 skill/tool 规则。局域网远程控制和 marketplace 则应单独立项，先完成威胁模型和真实设备 E2E。

不建议的“看似省事”做法：把所有 provider 配置塞进一个 active 字符串、把失败重试写进各 provider、把前端时间戳当作持久化事实、用单一总超时覆盖流式语音、或让导入的 persona 包直接拼接 system prompt。这些都会破坏当前工程已经建立的 generation、scope、sanitizer 和回退边界。
