# OpenHuman 可复用性研究（2026-08-27）

本文基于 OpenHuman 官方 GitHub 仓库当前浅克隆（主分支提交 `04075d5375d6adc53b0101194eadfbcefee5a953`，2026-08-27）以及仓库内官方文档/源码。目标是识别适合元元桌宠的架构借鉴点；没有复制 OpenHuman 代码，也没有修改产品代码。

## 1. 项目轮廓

OpenHuman 将自己定义为本地优先的个人 AI：持久化记忆（Memory Tree + Obsidian Wiki）、可恢复的 agent 编排、深度研究/工具集成，以及桌面 mascot、隐私模式和审批门。官方 README 明确其仍是 early beta，并把工作流、自动同步、模型路由、TokenJuice、17 个消息渠道等列为产品能力。[README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/README.md#what-is-openhuman)

仓库是一个 Rust 核心 + Tauri 桌面应用 + Web 前端的 monorepo。核心领域在 `src/openhuman/`，包括 `agent/`、`memory/`、`flows/`、`channels/`、`cron/`、`integrations/`、`security/`、`inference/`、`voice/`、`web_chat/` 等；桌面壳和移动壳在 `app/src-tauri*`。[源码目录](https://github.com/tinyhumansai/openhuman/tree/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman) · [Tauri 壳](https://github.com/tinyhumansai/openhuman/tree/04075d5375d6adc53b0101194eadfbcefee5a953/app/src-tauri)

## 2. 最值得借鉴的模块

### A. 分层记忆树，而非单一向量库

官方 Memory Tree 流程是：来源适配器 → Markdown 规范化并保留 provenance → 确定性分块（每块不超过约 3k token）→ 原子写入 Markdown 内容文件 → SQLite 保存 chunks/scores/summaries/jobs → 快速评分、实体抽取、embedding → source/topic/global 分层摘要树 → 检索。[memory-tree.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/obsidian-wiki/memory-tree.md)

它把重活放到持久化后台队列：`extract_chunk`、`append_buffer`、`seal`、`topic_route`、`digest_daily`、`flush_stale`，带去重键、重试、调度窗口和 worker lease 恢复。崩溃后过期 lease 会回队列，避免丢失已接纳但未封存的记忆。[memory-tree.md#2-queue](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/obsidian-wiki/memory-tree.md#2-queue) · [memory 模块说明](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/memory/README.md)

对元元的具体启发：

- 在现有 Memory v3 之上增加“来源/主题/全局摘要”三种视图，而不是把所有事实直接注入 system prompt。
- 将聊天回合、语音回合、外部观察统一成带 `source_id`、时间范围、敏感性和 provenance 的叶子记录；异步生成摘要和实体关系。
- 使用确定性 content-addressed ID、事务写入、有限队列和 lease/retry，延续本项目已有的 bounded/recoverable 约束。
- 前端设置页可以提供“按来源/主题/时间窗检索 + 打开原文”，但不必引入 Obsidian 依赖；Markdown 导出可作为可选互操作格式。

### B. 确定性检索与实体图

OpenHuman 的 `memory_tree` 是一个多模式工具：`search_entities`、`query_source`、`drill_down`、`cover_window`、`fetch_leaves`、`ingest_document`、`walk/smart_walk`，统一返回带 tree/source/time/provenance 的 `RetrievalHit`。[retrieval.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/obsidian-wiki/retrieval.md) · [dispatcher](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/memory/query/mod.rs)

`walk/smart_walk` 先做实体抽取，再利用共现图和摘要节点做纯算法路由，不调用 LLM；实体注册表以 canonical id + aliases 解决“同一个人多个叫法”。[retrieval.md#deterministic-walk](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/obsidian-wiki/retrieval.md#deterministic-walk-walk--smart_walk-no-llm)

建议借鉴为 `memory_recall` 的第二层：先解析人物/项目/宠物状态实体，再按来源和时间窗收窄召回，最后才让模型组织语言。这样可降低无关记忆注入、保留可解释引用，并与当前“选择性 recall”策略兼容。

### C. Agent harness、子代理与可恢复图

`src/openhuman/agent/README.md` 将 agent 定义为拥有工具调用循环、子代理派发、触发 triage、prompt 组装和记忆加载的领域；公共面包括 `Agent`/`AgentBuilder`、`run_subagent`、`ToolDispatcher`、`triage` 和 system prompt builder。[agent README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/agent/README.md)

工作流使用 typed node graph，运行状态通过 tinyagents checkpointer 持久化，可暂停等待人审、重启后恢复、取消并清理 checkpoint；流程 schema 直接暴露 `pending_approvals` 和 `checkpoint_thread_id`。[flows schemas](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/flows/schemas.rs#L200-L240) · [flows 文档](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/workflows.md)

适合元元的缩小版：把“后台主动对话”“记忆整理”“本地语音服务启动/恢复”建成有限状态图，每个节点有输入版本、取消点、重试策略和恢复记录；暂不需要完整可视化 workflow builder 或多级 agent fleet。

### D. 后台主动循环与资源调度

OpenHuman 的 subconscious loop/cron 将定时触发、外部事件和主动发送分离；频道文档说明主动发送必须有明确默认投递目标，不能向空 recipient 发送。[channels.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/channels.md#outbound) · [subconscious 文档](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/subconscious.md)

其 `scheduler_gate` 在电量、机器负载、登录状态等条件不合适时阻塞后台 LLM 工作，并用单进程信号和 semaphore 限制并发。[scheduler gate README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/cron/scheduler_gate/README.md)

元元已有主动 realtime 规则，可借鉴“统一后台容量门”：把 fresh-topic 预取、Memory consolidation、VAD shadow、语音模型 warmup 共享一个低优先级调度门，并在电池/CPU/通话/用户忙碌时暂停；主动消息必须经过当前的节奏、冷却和用户偏好规则。

### E. 审批门、隐私模式与安全边界

OpenHuman 将外部副作用工具调用（发送消息、OAuth、付费/网络动作等）放入全局 ApprovalGate；工作流可以在 approval 节点暂停，之后从 durable checkpoint 恢复。[approval-gate.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/approval-gate.md) · [源码 approval](https://github.com/tinyhumansai/openhuman/tree/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/security/approval)

Privacy Mode 是一个由 Rust 核心强制的“一键不出机”模式，而非仅 UI 提示；隐私与安全文档还描述设备端加密、OS keyring、沙箱和 egress policy。[privacy-and-security.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/privacy-and-security.md) · [privacy-mode.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/privacy-mode.md)

建议元元增加两个明确的产品契约：

1. 将“学习/写入长期记忆”“外部搜索”“发送或分享内容”分成不同风险等级，统一走可审计的确认事件；后台主动和 realtime 不得绕过。
2. 将 `textProvider=local`、fresh-topic、TTS/ASR 的网络边界在 Rust 侧强制执行，UI 只显示状态；诊断继续采用当前文本-free、allow-list 设计。

### F. Token 压缩与成本/可观测性

TokenJuice 在工具结果进入模型前做内容压缩，官方声称可显著减少 token；其实现位于 `src/openhuman/inference/tokenjuice/`，并有只读 RPC 查看路由状态。[README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/README.md#the-brain) · [token-compression.md](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/token-compression.md) · [源码](https://github.com/tinyhumansai/openhuman/tree/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/inference/tokenjuice)

元元可先做非 ML、可测试的版本：对 Memory 检索结果、fresh-topic 观察、工具错误和历史回合使用固定字段截断/去重/摘要预算，并在诊断中只记录输入/输出 token 计数和压缩原因，不记录文本。

### G. 渠道/集成的声明式契约

OpenHuman 的 `Channel` trait 统一 inbound/outbound，provider 连接器由定义表和 feature gate 管理；凭据由独立 security 层持有。[channels README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/channels/README.md) · [traits](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/channels/traits.rs)

对元元的适用范围较窄：可把当前 DeepSeek、Ollama、Tavily、Volcano、CosyVoice/本地服务抽象成 provider capability + health/status + credential scope，但不宜现在引入 17 个消息渠道。优先保持“provider-neutral wire + 明确能力协商”这一现有 realtime 方向。

## 3. 不应直接复刻的部分

- OpenHuman 的完整集成生态（100+ OAuth、5000+ MCP、17 渠道）、TinyPlace/x402 经济系统、会议接入和图形化 workflow builder，超出桌宠的核心交互面，且会显著扩大凭据、网络和安全审计范围。
- “Memory Tree + Obsidian”是很好的数据模型，但直接引入其 TinyMemory/TinyCortex 依赖会与本项目现有 Memory v3、SQLite schema 和同步合同发生边界冲突；应吸收状态机/队列/来源模型，而不是搬运 crate。
- OpenHuman 的 server/cloud subscription、Exa 等供应商路径不能改变本项目当前“本地优先、显式启用外部观察、Rust 强制 loopback”的约束。

## 4. 许可证与复制边界

OpenHuman 根目录 `LICENSE` 是 GNU GPL v3；核心 `Cargo.toml` 明确声明 `GPL-3.0-only`。[LICENSE](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/LICENSE) · [Cargo.toml package metadata](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/Cargo.toml#L1-L15)

本项目 `package.json` 与 `src-tauri/Cargo.toml` 当前为 MIT。因此：

- 可以借鉴公开文档描述的架构、协议思想和独立实现的算法设计；
- 不应把 OpenHuman GPL 源码、复制性代码片段或其 GPL 依赖直接链接进本项目的 MIT 发行物；
- 若未来需要复用具体代码，应先做逐文件版权/许可证审计，并由项目维护者决定是否隔离进 GPL 组件、改变发行许可证或改写为独立实现；
- OpenHuman 依赖和子模块可能有各自许可证，不能只看根 LICENSE。

## 5. 面向元元的落地顺序

1. **短期**：为 Memory v3 增加 source/topic/time-window 召回视图、canonical entity、统一 provenance 和事务化后台 consolidation job；复用现有 bounded queue/diagnostic 规则。
2. **中期**：建立轻量 `background scheduler gate` 与可恢复任务记录，将 fresh-topic、记忆整理、语音服务维护纳入同一容量/取消/重试模型。
3. **随后**：把高风险外部动作接入统一 approval/egress policy，并在设置页提供可解释的 pending action 列表。
4. **暂缓**：完整多渠道、工作流画布、多级 agent fleet、外部 agent economy 和大规模 OAuth marketplace。

以上顺序是针对本项目现有边界的工程建议，不代表 OpenHuman 官方路线图或兼容性承诺。

## 6. 第二轮深挖：README 不显眼但值得借鉴的机制

本节继续基于同一固定提交 `04075d5375d6adc53b0101194eadfbcefee5a953`。重点不是再列一遍“大模块”，而是看它如何处理桌面应用最容易出问题的恢复、状态、权限和测试边界。

### H. 可冷启动恢复的线程与回合快照（建议借鉴，局部搬运）

OpenHuman 不只保存聊天消息，还会把“正在进行的这一回合”定期写成每线程一个快照：当前阶段、工具时间线、子代理活动、取消/中断状态。文件采用临时文件写入、持久化后原子替换；程序下次启动时，未完成快照会自动标成 `Interrupted`，已完成快照保留用于“查看处理过程”的回放。[threads README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/threads/README.md) · [turn_state store](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/threads/turn_state/store.rs)

对元元的提升：实时语音或普通聊天在崩溃、切窗、电脑睡眠后，不会只剩半截消息；设置页可以显示“上次回合在工具调用/生成/播放哪个阶段中断”，用户点击继续时可从明确的恢复点开始。适合把当前 `chat.js`/`realtime.js` 的内存状态做一个**低频、脱敏、文本可选**的恢复快照，不要把 PCM、密钥或完整诊断塞进去。快照写盘必须放到阻塞线程，避免拖住 Tauri IPC。

### I. 只读运行日志回放与迟到客户端补齐（强烈借鉴）

TinyAgents 的运行日志为每个事件分配单调 offset，提供 `run_events(offset, limit)` 分页回放、`run_status` 最新状态和 `runs_active` 活跃列表。这使 UI 断线重连后可从上次 offset 继续，而不是猜测当前状态；返回的是持久化事件类型本身，避免另造一套容易漂移的 DTO。[replay schemas](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/agent/tinyagents/replay/schemas.rs)

对元元的提升：聊天窗口、紧凑通话胶囊或设置页重新打开时，可以补齐错过的 `chat-window-mode`、语音服务启动、记忆整理等状态；诊断报告可以回答“发生顺序是什么”，而不是只有最后一个错误。建议做固定大小的环形事件账本，事件只含枚举、计数、相对时间和脱敏 id，沿用当前诊断的 text-free 约束；不建议把完整用户/助手文本做事件日志。

### J. 目标与待办看板：从“记住”到“跟进”（适合做产品功能）

OpenHuman 同时提供长期目标（`memory_goals`）和线程内任务看板（todo/kanban）。目标有独立的增删改和一次性反思/enrichment；看板有单一 `in_progress` 约束、原子 claim、运行记录、心跳、过期 reclaim。它把“用户想长期完成什么”和“当前回合下一步做什么”分开。[goals schemas](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/memory/goals/schemas.rs) · [todos README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/threads/todos/README.md)

对元元的提升：元元可以把“下周提醒我练琴”记录成承诺，把“这次帮我整理资料”拆成可取消的小步骤；语音主动关怀只读取用户明确允许的目标/承诺，不把所有记忆都当成待办。建议先做 3 状态小看板（待处理/进行中/完成），加过期与取消，暂不做完整工作流画布或自动替用户创建大量任务。

### K. 通知中心是“持久收件箱”，不是瞬时 toast（值得借鉴）

通知分为外部集成通知和核心事件通知。核心通知先写 SQLite 再广播，因此应用关闭时发生的事件下次仍能同步；外部通知先入库，再由后台本地模型评分，经过 provider 阈值和 `route_to_orchestrator` 二次检查才升级给 agent。重复内容在 60 秒窗口内折叠，生命周期为 unread/read/acted/dismissed。[notifications README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/desktop/notifications/README.md) · [GitBook](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/notifications-and-activity.md)

对元元的提升：记忆整理失败、本地语音服务恢复、fresh-topic 刷新完成等不会被一次 toast 吞掉；用户打开设置时能看到未读、失败和可重试项目。可先实现一个本地 `activity inbox`，只收元元自己的系统事件，不接入 Gmail/Slack 等大生态；主动语音必须在通知被用户明确允许后才触发。

### L. 任务提示式模型路由与能力校验（建议借鉴，不搬供应商生态）

OpenHuman 用 `hint:fast`、`hint:reasoning`、`hint:vision` 等稳定提示把“任务类型”与具体 provider/model 解耦，映射可热更新；子代理还可单独 pin 模型。路由前会检查模型是否真的支持 vision/embedding，避免聊天模型静默丢图。[routing README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/model-routing/README.md) · [local/BYOK](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/features/model-routing/local-and-byok-models.md)

对元元的提升：可把“日常闲聊/深度思考/图片理解/记忆压缩/本地离线”做成固定能力 hint，按设置映射到 DeepSeek、Ollama 或本地服务；换模型不必改 persona 和业务逻辑。当前已有 text/vision provider，下一步只需增加 allow-listed capability registry 和统一 fallback；不要引入 OpenHuman 的订阅、几十家 provider 或自动把敏感语音送云端。

### M. 配置迁移、回滚和跨机恢复说明（非常值得照搬方法）

配置由 `schema_version` 严格按顺序迁移。每一步都要求幂等；只有迁移成功并保存后才提升版本，保存失败则回滚内存版本，下次启动重试；迁移错误记录警告但不把应用启动直接“砖死”。旧会话目录迁移也有 marker，目标已存在时不覆盖新数据。[migration README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/config/migrations/README.md) · [session migration](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/agent/harness/session/migration.rs) · [move to new PC](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/guides/move-to-new-pc.md)

对元元的提升：以后新增 realtime、VAD、memory 字段时，旧用户升级不会丢设置；坏字段可归一化为安全默认；跨机搬迁时清楚区分“可复制的 persona/记忆”和“必须重新输入的 key/模型权重”。建议所有 Rust 设置新增字段都走版本迁移，保存前写临时文件并保留旧文件；迁移失败不得阻塞启动，也不得静默跳过版本。

### N. 子进程目录沙箱与应用层策略分离（只在增加工具后采用）

`cwd_jail` 是声明式目录 jail：先 canonicalize 根目录和只读目录，再根据系统选择 macOS Seatbelt、Linux Landlock、Windows AppContainer，最后才启动子进程；没有 OS 能力时降级为 noop，但调用方仍应保留应用层路径检查。它特意只约束被启动的子进程，不把整个核心进程放进沙箱。[cwd_jail README](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/sandbox/cwd_jail/README.md)

对元元的提升：若未来允许元元运行脚本、处理用户文件或调用插件，可把“审批门”与“子进程看到的目录/网络”分成两道独立闸门，降低误删和越权风险。当前没有系统工具执行面时不要为了“看起来安全”引入沙箱；Windows backend 在该提交仍有无法桥接 `Child` 的已知限制，必须先做真实平台验证。

### O. 结构化错误、幂等键与失败可观察性（小机制，大收益）

线程模块把“线程不存在”编码成固定 `ThreadNotFound` 结构化错误，前端可精确清理陈旧引用，不靠字符串匹配；频道总线为发送消息生成确定性幂等键，重试不会重复发送。[threads error](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/threads/error.rs) · [channel bus](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/src/openhuman/channels/bus.rs#L1290-L1322)

对元元的提升：窗口切换、重连、语音重试和安装器重跑时，可以区分“旧 generation”“资源不存在”“可重试 provider 错误”；设置保存、通知摄取和 realtime 控制消息都能安全重试。建议把结构化错误枚举和 idempotency key 作为现有 IPC/loopback 协议的公共合同，并为每个新错误路径补一个失败测试。

### P. 测试与 E2E 观测的工程纪律（应吸收流程，不复制工具）

OpenHuman 把 Rust 单测、跨域集成、Vitest、WDIO 桌面 E2E、OS 手工 smoke 分层；E2E 用固定 `data-testid`、隔离工作目录、mock backend、失败时截图和 DOM dump，并要求每个功能至少有一个失败/边界断言。[testing strategy](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/developing/testing-strategy.md) · [E2E guide](https://github.com/tinyhumansai/openhuman/blob/04075d5375d6adc53b0101194eadfbcefee5a953/gitbooks/developing/e2e-testing.md)

对元元的提升：现有项目已经有 JS/Python/Rust gate，可进一步为窗口模式、麦克风权限、服务启动恢复、设置迁移加固定 `data-testid` 和隔离临时 workspace；失败时保存脱敏状态快照，避免只看“测试超时”。跨平台 Tauri/音频路径仍须真实 macOS/Windows smoke，不能把 mock 测试当成 OS 验证。

## 7. 第二轮结论：优先级调整

**可以直接以独立实现搬入的形状**：线程回合快照、只读事件回放游标、目标/待办三态看板、持久 activity inbox、结构化错误和幂等键、配置 schema migration runner。

**应该借鉴设计但保持当前合同**：任务 hint 路由、能力 registry、scheduler gate、审批与 egress 分层、子进程 jail、分层 E2E/手工 smoke。

**暂不建议搬入**：完整 OAuth/消息渠道、联网设备配对和 agent economy、远程 hosted orchestration、完整 TinyAgents/TinyMemory crate、默认自动观察系统。它们要么扩大隐私/凭据面，要么会与当前 realtime、Memory v3、Rust loopback 和 MIT 发行边界冲突。
