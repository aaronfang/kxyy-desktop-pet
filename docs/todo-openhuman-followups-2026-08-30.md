# OpenHuman 借鉴后续待办

日期：2026-08-30  
用途：记录讨论中已经确认、但当前版本尚未完成的工作，避免把“已有基础”误认为“完整功能”。

## 当前已完成的基础

- Memory v3/v3.1：facts、episodes、commitments、证据、FTS、事件重放、Memory Graph、Workspace 和实时通话记忆边界。
- 配置迁移、原子备份、回合快照、Activity 基础存储、能力快照、目标/TODO 基础存储。
- 设置页已提供“管理中心”，可查看能力、Activity 和手动目标。
- Silero VAD 已可选安装并 shadow-only 运行；RMS 仍是唯一线上决策路径。

以上项目不应重复实现或另建第二套事实库。

## P0：先修正当前用户体验

### 1. 目标与待办的信息架构

当前问题：目标放在“管理中心”只是临时入口，位置不够自然。

- [ ] 将目标/TODO 移到独立“目标”页签，或放入“记忆”页的“承诺与目标”区域。
- [ ] 明确区分长期目标、Memory commitment、当前会话 objective 和普通 TODO。
- [ ] 增加删除、过期、不要再提醒、筛选和空状态说明。
- [ ] 保持 card/user scope 隔离，删除目标后不留活动通知、召回引用或主动语音队列。

### 2. 目标来源与状态变更

当前行为是完全手动添加、手动切换状态。

- [ ] 设计“从聊天建议创建目标”的确认流程；默认只建议，不自动写入。
- [ ] 仅在用户明确表达目标/提醒意图并确认后创建，普通愿望表达不能误建任务。
- [ ] 支持聊天中明确确认完成后建议标记完成，仍需用户确认。
- [ ] 支持从现有明确的 Memory commitment 转为目标，但必须幂等且保留来源。
- [ ] 增加过期和取消规则；主动语音只能读取用户明确允许的目标。
- [ ] 自动化测试覆盖误识别、确认、拒绝、重复创建、完成、取消、过期和重启恢复。

## P1：分层记忆树的未完成部分

当前只完成了分类记忆、来源/evidence、事件日志、索引、图和临时 Workspace；尚未完成 OpenHuman 风格的“来源 → 主题 → 全局摘要树”。

- [ ] 定义来源节点、主题节点、全局摘要节点的 schema 和版本。
- [ ] 实现确定性 chunk：固定字符/token 上限、来源 provenance、敏感内容过滤。
- [ ] 实现后台流水线：`extract_chunk`、`topic_route`、`digest_daily`、`flush_stale` 等最小子集。
- [ ] 为每个后台 job 增加幂等键、重试上限、取消点、lease 过期回收和 Activity 记录。
- [ ] 增加 source/topic/global 三种只读视图，不改变现有 facts/episodes/commitments 的事实语义。
- [ ] 先做离线摘要和召回对比，确认摘要不会丢失证据、冲突或时间边界。
- [ ] 在通过对比测试前，不得把摘要树接入实际聊天 prompt。
- [ ] 接入聊天时采用灰度/feature flag；无摘要、超时、冲突或过滤失败时回退当前 Memory recall。
- [ ] 明确 Markdown/Obsidian 导入导出边界，不能形成第二事实库。

### 确定性实体检索

- [ ] 建立 canonical entity 与 aliases 注册表，解决同一人物/项目/宠物的不同叫法。
- [ ] 为 `memory_recall` 增加 source/topic/time-window/entity 的可解释过滤视图。
- [ ] 增加不调用 LLM 的 `walk`/`drill-down` 类纯算法检索，召回失败时回退现有选择性 recall。
- [ ] 测试同义词、跨来源合并、时间窗边界、实体冲突和 card/user 隔离。

## P1：Silero VAD 从观察到可用的验证链

当前 Silero 只做 shadow 观测，不能改变 RMS、ASR、句尾或打断决策。

- [ ] 准备有录音授权、语音同意、来源和标注记录的本地评测集。
- [ ] 覆盖正常说话、短句、连续讲话、停顿、桌宠回声、键盘、风扇、环境噪声和非目标人声。
- [ ] 用同一帧输入并行比较 RMS 与 Silero：误触发、漏检、候选确认、句尾和打断延迟。
- [ ] 扩展离线 evaluator 报告：只输出固定聚合计数、ppm 和延迟桶，不输出录音、文本或原始概率。
- [ ] 在 macOS 和 Windows 真实设备验证 CPU/内存、音频线程阻塞、安装失败、runtime 崩溃和回退。
- [ ] 只有在授权评测和跨平台 smoke 均显示稳定收益后，才允许先辅助句尾、再辅助候选筛选。
- [ ] 最后才评估参与打断决策；任何异常必须自动回退 RMS，并保留显式开关。
- [ ] Volcano 云端路径不得因本地 Silero 评测结果自动启用该决策链。

## P2：已建合同但尚未完全接入业务

### 可恢复 agent 状态图

- [ ] 把后台主动对话、Memory 整理、语音服务维护抽象成有限状态图。
- [ ] 每个节点定义输入版本、取消点、重试策略、超时和恢复动作。
- [ ] 增加只读 checkpoint/run status 查询；不实现完整 workflow 画布或多级 agent fleet。

### 只读事件回放

- [ ] 为关键运行事件分配单调 offset，提供 `run_status`、活跃列表和分页回放接口。
- [ ] 窗口或通话胶囊重连时按 offset 补齐错过事件，不依赖一次性广播。
- [ ] 事件只保存枚举、计数、相对时间和脱敏 ID；禁止保存完整聊天文本、PCM 和密钥。
- [ ] 测试旧 offset、重复回放、迟到事件、容量上限和重启恢复。

### 能力注册表与任务路由

- [ ] 将 `chat-fast`、`reasoning`、`vision`、`memory-summary`、`local-offline`、`voice` hint 接入真实请求入口。
- [ ] 路由前校验 provider 能力；不支持 vision、流式或本地离线时必须安全回退。
- [ ] 未知 hint、模型不存在、网络失败和空配置均有固定行为和自动测试。
- [ ] 确保 local 模式不会意外产生网络请求，敏感语音不会自动切到云端。

### Activity 与后台调度门

- [ ] 将 Memory consolidation、fresh-topic refresh、VAD shadow、voice warmup 的真实事件写入 Activity。
- [ ] 增加统一低优先级 scheduler gate：通话、用户忙碌、低电量、资源不足时延后任务。
- [ ] 广播失败不能丢持久化记录；重试不能重复执行 operation。
- [ ] 设置页增加重试、忽略、清理过期项，并自动刷新未读状态。

### 隐私模式与网络出口策略

- [ ] 增加 Rust 强制的“一键不出机”模式，不能只依赖 UI 提示。
- [ ] 将 local text、Memory、fresh-topic、TTS/ASR、外部搜索的网络出口写成 allow-list policy。
- [ ] 隐私模式开启时，所有云端请求和后台外部观察必须被拒绝并给出固定原因；本地功能仍可用。
- [ ] 增加策略单元测试、断网测试和设置页可解释状态；诊断不得包含 URL、密钥或原始错误。

### Token/上下文预算

- [ ] 对 Memory recall、fresh-topic、工具错误和历史回合实现固定字段截断、去重和摘要预算。
- [ ] 先采用非 ML 的确定性压缩，不改变原始 Memory 数据，只改变进入模型的观察块。
- [ ] 诊断只记录输入/输出 token 计数、压缩原因和耗时，不记录文本。
- [ ] 测试超长输入、重复内容、注入文本、压缩失败和预算回退。

### Provider 凭据与健康合同

- [ ] 为 DeepSeek、Ollama、Tavily、Volcano、CosyVoice 和本地服务统一声明能力、健康状态和凭据 scope。
- [ ] 凭据只由 Rust 持有；前端只能读取固定状态，不能读取原始 key 或 provider URL。
- [ ] provider 不可用、能力不匹配和凭据缺失必须返回结构化错误并安全回退。

## P3：可选增强

- [ ] 外部操作审批：默认拒绝、确认/拒绝/超时/重启恢复、TTL、审计和幂等。
- [ ] 子进程文件沙箱：路径穿越、符号链接、只读目录、进程退出和 macOS/Windows 验证。
- [ ] Markdown/Obsidian 脱敏导出；导入必须显式触发、按 scope 隔离并幂等。
- [ ] 目标与 Memory commitment 的可解释关联，但不复制第二事实库。

## 发布前统一验收

- [ ] 每个条目先补 Red → Green 行为测试，再跑受影响套件。
- [ ] 最终运行 `npm run test:gate`、`npm run build` 和 macOS 真实 App smoke。
- [ ] Windows 安装、WebView2、设置迁移、语音服务恢复和 VAD runtime 必须在 Windows 真实环境补测。
- [ ] 记录应用版本、Memory schema/milestone、commit、构建产物和未运行项目。
- [ ] 未满足验证门槛的能力必须保持关闭或 shadow-only，不能用 mock 结果替代真实设备结论。
- [ ] 为关键 Tauri 窗口和设置控件补固定 `data-testid`，E2E 使用隔离 workspace 与 mock backend。
- [ ] E2E 失败自动保存脱敏截图、DOM/状态快照和 mock 请求摘要，禁止保存文本、PCM、密钥或路径。

## 明确不做

不复制 OpenHuman GPL 代码或依赖；不引入完整 TinyMemory/TinyAgents、自动观察屏幕/系统音频、OAuth 消息生态、远程 agent economy，也不允许外部观察或学习记忆修改 persona/system/skill 规则。
