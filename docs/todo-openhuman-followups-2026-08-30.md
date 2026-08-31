# OpenHuman 借鉴后续待办

日期：2026-08-30  
用途：记录讨论中已经确认、但当前版本尚未完成的工作，避免把“已有基础”误认为“完整功能”。

## 当前已完成的基础

- Memory v3/v3.1：facts、episodes、commitments、证据、FTS、事件重放、Memory Graph、Workspace 和实时通话记忆边界。
- 配置迁移、原子备份、回合快照、Activity 基础存储、能力快照、目标/TODO 基础存储。
- 设置页已提供“管理中心”，可查看能力、Activity 和手动目标。
- Silero VAD 已可选安装并 shadow-only 运行；RMS 仍是唯一线上决策路径。

以上项目不应重复实现或另建第二套事实库。

## 当前实现状态（2026-08-30）

- `P0 / Goal-TODO`：基础信息架构、类型与状态机、结构化 IPC、删除、截止日期、过期筛选、聊天建议确认卡、Goal revision/staleRevision 防覆盖、提醒候选纯函数 gate、稳定排序/筛选、Goal 显式 scope（旧数据迁移到 default）、长期目标/TODO 独立容量上限、截止时间范围校验、提醒 dry-run Activity、取消/删除/忘记分流契约与 UI 入口已完成；记忆列表已接入 commitment→待办入口（幂等、保留 sourceRef），提醒主动语音运行时、真实 App 交互验收、完成确认语义和跨事务遗忘恢复仍未完成。
- `M0 / recall baseline`：已完成有界聚合评估函数（含 P95 延迟、最大注入字符、无关率、来源完整度）、8 类脱敏 fixture（偏好/关系/经历/承诺/冲突/过期/私密/scope 隔离）和基线测试；真实设备延迟采集仍待补充。
- `M1 / MemorySourceCard`：纯契约、脱敏、scope/consent 校验、幂等写入边界和测试已完成。
- `M2 / extract_chunk`：Unicode 确定性分块、content-addressed id、schema v7、来源卡/chunk/job 同事务写入、claim/lease/cancel/finish/list/retry、固定重试退避、启动时崩溃恢复、现有 Memory worker 的实际处理和有界纯算法已完成；文字聊天完整成功回合和实时语音播放完成 receipt 已接入 SourceCard ingest。用户文档导入入口已撤回，不作为产品功能；文档自动物化 fact/episode/commitment 仍未接入。
- `M3 / entity index`：canonical entity/alias 注册表、按实体/来源/时间/scope 的纯算法 `memoryWalk` 查询，以及 scope 隔离的 SQLite alias 表、upsert/list/clear IPC 和只读 `memory_entity_walk` IPC 已完成；尚未接入聊天召回灰度。
- `M5 / entity recall adapter`：已完成默认关闭、bounded、失败回退的前端适配器和测试；尚未为 card/user 开启灰度开关。
- `M5 / summary adapter`：已完成默认关闭、bounded、无 provenance 回退的前端适配器和测试；尚未为 card/user 开启灰度开关。
- `M4 / source summary`：已完成保留来源、时间边界、冲突键和不确定标记的 source-level rolling summary、离线对比（命中/字符增量）纯函数、可重建 topic grouping/global aggregate、测试和只读 `memory_source_summary` IPC；尚未接入摘要 job 或聊天 prompt。
- `M4 / daily digest`：已完成有界 `digest_daily` 纯算法及默认关闭的灰度适配器和测试；尚未接入后台调度或聊天 prompt。
- `M6 / explainability`：已完成固定字段、脱敏的 recall explanation 纯函数、测试和记忆列表 UI 展示；仍未接入批量筛选/导出预览。
- 验证证据：`npm run test:gate`、Rust Memory/Goal 测试、`cargo check` 和 `git diff --check` 均通过；开发版使用 `KXYY_DEV_OPEN_SETTINGS=1` 自动打开设置窗口并完成可见性 smoke（2026-08-30 macOS）；本轮自动实测确认设置窗口、模型/记忆页签和开发入口可见，Goal/Memory 逐项交互、Windows App 验收仍待执行。

## P0：先修正当前用户体验

### 1. 目标与待办的信息架构

当前问题：目标放在“管理中心”只是临时入口，位置不够自然。

- [ ] 将目标/TODO 移到独立“目标”页签，或放入“记忆”页的“承诺与目标”区域。
- [ ] 明确区分长期目标、Memory commitment、当前会话 objective 和普通 TODO。
- [x] 增加删除、过期、筛选和空状态说明；“不要再提醒”已由 `reminderPolicy=never` 契约覆盖，运行时入口仍待接入。
- [ ] 保持 card/user scope 隔离，删除目标后不留活动通知、召回引用或主动语音队列。

### 2. 目标来源与状态变更

当前行为是完全手动添加、手动切换状态。

- [x] 设计“从聊天建议创建目标”的确认流程；默认只建议，不自动写入。
- [x] 仅在用户明确表达目标/提醒意图并确认后创建，普通愿望表达不能误建任务。
- [ ] 已增加显式完成措辞的纯建议识别，仍需接入聊天确认卡和 Goal transition，模型推断/第三方消息不得自动关闭。
- [ ] 支持从现有明确的 Memory commitment 转为目标，但必须幂等且保留来源（纯转换契约与测试已完成，UI/IPC 入口待接入）。
- [x] 增加过期和取消规则；主动语音只能读取用户明确允许的目标。
- [ ] 自动化测试覆盖误识别、确认、拒绝、重复创建、完成、取消、过期和重启恢复。

### P0 目标/临时任务实施分解（按 Red → Green 垂直切片）

本节把上面的粗略 TODO 拆成可独立交付的步骤。原则是：长期目标、Memory commitment、当前会话 objective 和临时 TODO 是四种不同语义；只允许用户确认后的结果进入持久化 Goal/TODO 存储。不要把所有内容合并成一张“万能任务表”，也不要让模型直接改状态。

#### G0：冻结术语和状态机（先写失败测试）

- [x] 定义四类对象的边界：`long_term_goal`（跨会话、用户持续追求）、`todo`（可执行的小事项）、`commitment`（从对话中提取的待兑现承诺，事实记忆的一部分）、`session_objective`（仅当前会话有效，不落长期存储）。
- [x] 定义长期目标状态：`active`、`paused`、`completed`、`cancelled`、`expired`；定义 TODO 状态：`active`、`in_progress`、`blocked`、`done`、`cancelled`、`expired`。状态迁移表要拒绝非法跳转，完成/取消/过期必须记录时间。
- [x] 先补纯函数测试：目标/TODO 类型边界、已完成项/过期项提醒过滤、session objective 不进入 Goal API 均有覆盖；真实跨进程重启验证仍待补充。
- [x] 固定每种对象的最小字段和字符上限：`id`、`kind`、`title`、`description`、`status`、`createdAt`、`updatedAt`、`dueAt`、`source`、`sourceRef`、`reminderPolicy`；未知字段按版本策略处理。

#### G1：扩展现有 Goal 存储（兼容旧数据）

- [x] 在现有 `Goal` 上增加 `kind`、`description`、`dueAt`、`source`、`sourceRef`、`reminderPolicy`、`completedAt`、`cancelledAt`、`schemaVersion`；旧 `goals.json` 无字段时按 `long_term_goal + active` 兼容读取。
- [x] 将长期目标/TODO 拆成独立容量上限；写入前校验标题非空、长度、合法状态、scope 和 dueAt 时间范围。
- [x] 使用临时文件 + rename 保持原子保存；写入失败时内存状态和磁盘状态都不应半更新，并增加失败持久化回归测试。损坏 JSON、磁盘满、权限改变和并发 upsert 的专项测试仍待补齐。
- [x] 增加显式删除 API 和“软删除/过期”策略：默认删除只影响 Goal/TODO，不删除其来源 Memory；只有用户执行“忘掉这件事”时才走 Memory 删除流程。
- [ ] 增加一次性 schema migration：迁移成功才写新版本标记；失败保留旧文件并在 Activity 中给出可重试错误。

#### G2：完善 Rust IPC 合同和前端信息架构

- [x] 将 `goal_list/upsert/set_status` 扩展为带过滤的 `goal_list({kind,status,includeExpired})`、`goal_create`、`goal_update`、`goal_transition`、`goal_delete`；旧命令仍保留兼容。
- [x] 状态更新返回结构化结果：`ok`、`notFound`、`invalidTransition`、`expired`、`staleRevision`。
- [x] 设置页把长期目标和 TODO 分成两个列表/页签；每个列表提供添加、编辑、暂停、完成、取消、删除、过期筛选和空状态。输入控件明确显示“目标”或“待办”，不再使用“目标或待办”的模糊占位。
- [ ] 所有按钮和列表项补固定 `data-testid`、键盘操作、焦点状态和中文错误提示；窄窗口下长标题换行，不改变行高布局。
- [ ] 测试跨窗口刷新、重复点击、旧 revision 更新、删除后回到列表、重启后排序和 scope 隔离。

#### G3：实现从聊天创建的“建议 → 确认”流程

- [x] 在 `conversation-director` 的目标/计划意图识别基础上增加候选类型和置信度；只把明确表达“我想/我要/计划/提醒我”且包含可执行内容的消息生成候选。
- [x] 对“我好想学会画画”“以后有空再说”等愿望或闲聊只生成低置信度候选，默认不弹确认；禁止从模型臆测、普通情绪表达或第三方文本自动创建。
- [x] 聊天回复中使用非阻塞确认卡：显示候选类型、标题、可选截止时间和提醒策略；用户确认后调用 `goal_create`，拒绝则只记录一次 session 内的 dismissed，不写长期存储。
- [x] 候选带 `sourceMessageId` 和幂等键；重复确认、重试或窗口重连不得创建两条记录。用户编辑标题/截止时间后再保存最终值。
- [x] 失败时保留聊天回复，不阻塞正常对话；UI 显示“未保存，可重试”，而不是让模型假装已经记住。

#### G4：目标、TODO 与 Memory commitment 的转换规则

- [ ] 只允许用户显式操作“转为目标/转为待办”；转换保留 `source=memory_commitment` 和原 commitment id，不复制正文到第二份事实库，必要时只保存引用。
- [ ] 已接入聊天中的明确完成/取消建议卡，并要求再次确认；真实 App 验收及更多重连/回合边界测试仍待补充，模型推断、相似句或第三方消息不会自动关闭。
- [x] 目标取消、删除和“忘掉这件事”分开：取消停止提醒但保留来源；删除移除工作项；Goal 来源为 commitment 时“忘掉来源”才调用 Memory 删除事务；完整跨事务恢复仍待补充。
- [ ] 过期只改变工作项状态，不修改事实记忆；重新激活生成新的状态事件而不是覆盖历史。
- [ ] 测试 commitment→goal 幂等、goal→commitment 禁止隐式回写、完成/取消/忘记的边界和事件重放结果。

#### G5：提醒与主动语音的安全接入

- [ ] 为每个长期目标/TODO 增加 `reminderPolicy`：`never`、`manual_only`、`allowed_when_relevant`；默认 `manual_only`，不得因为创建目标就开启主动语音。
- [ ] 提醒候选纯函数和启动 dry-run Activity 已限制 active、未过期、`allowed_when_relevant` 并一次返回一个；尚未接入主动语音调度运行时。
- [ ] 提醒文案只引用标题和必要的截止信息，不把来源消息、私密原文或 Memory 片段直接读出来；用户拒绝后按目标级 cooldown 退避。
- [ ] 主动语音失败、挂断、打断或旧 generation 时不改变目标状态；只有用户确认“完成/取消/稍后提醒”才写状态。
- [ ] 测试默认不提醒、相关性过滤、重复提醒抑制、低电量/通话暂停、拒绝退避、重启恢复和跨 card/user 隔离。

#### G6：任务板和可解释性（最后接 UI）

- [ ] 先提供三态最小任务板（待处理/进行中/完成），再逐步增加 blocked、dueAt 和取消；不要一开始引入完整 workflow graph。
- [ ] 每个任务显示“来源：手动/聊天确认/commitment 转换”“创建时间”“截止时间”“最近一次状态变更”；不显示敏感原文。
- [x] 已提供确定性的状态/截止时间/来源/scope 过滤纯函数和 overdue → due soon → active → paused 排序；设置页当前仅接入排序。
- [ ] 增加导出/备份和恢复前预览；导入必须显式确认、按 scope 隔离、幂等，并拒绝未来版本 schema。
- [ ] 增加真实 App 验收：设置页创建/编辑/拖动状态、聊天确认、重启恢复、删除后不再召回、不触发未授权语音。

#### P0 完成门槛

- [ ] G0–G6 的纯函数、Rust IPC、前端行为和重启恢复测试通过；覆盖正常、边界、非法输入、拒绝、取消、重试、过期和状态恢复。
- [ ] 现有 `goal.rs`、Memory commitment、Activity 和聊天建议没有形成重复事实库；每条持久化工作项都有唯一来源和 scope。
- [ ] `npm run test:gate` 全绿，并完成一次 macOS 真实 App 验收；涉及主动语音或本地服务时补做 Windows 验收。
- [ ] 在完成门槛前，聊天只提供建议卡，主动语音只读取手动允许的目标；不得把“模型识别到目标”当成“用户已经同意创建”。

## P1：分层记忆树的未完成部分

当前只完成了分类记忆、来源/evidence、事件日志、索引、图和临时 Workspace；尚未完成 OpenHuman 风格的“来源 → 主题 → 全局摘要树”。

- [x] 定义来源节点、主题节点、全局摘要节点的 schema 和版本。
- [x] 实现确定性 chunk：固定字符/token 上限、来源 provenance、敏感内容过滤。
- [ ] 实现后台流水线：`extract_chunk` worker、`topic_route`/`digest_daily`/`append_buffer`/`flush_stale` 纯算法已完成；派生 job worker 调度仍未完成。
- [ ] 为每个后台 job 增加幂等键、重试上限、取消点、lease 过期回收和 Activity 记录。
- [x] 增加 source/topic/global 三种有界只读视图，不改变现有 facts/episodes/commitments 的事实语义。
- [x] 已完成离线摘要和召回对比聚合，保留证据来源、冲突和时间边界；真实 fixture 门槛采集仍待补充。
- [ ] 在通过对比测试前，不得把摘要树接入实际聊天 prompt。
- [ ] 接入聊天时采用灰度/feature flag；无摘要、超时、冲突或过滤失败时回退当前 Memory recall。
- [ ] 明确 Markdown/Obsidian 导入导出边界，不能形成第二事实库。

### 确定性实体检索

- [x] 建立 canonical entity 与 aliases 注册表，解决同一人物/项目/宠物的不同叫法。
- [x] 为 `memory_recall` 增加 source/topic/time-window/entity 的可解释过滤视图。
- [x] 增加不调用 LLM 的 `walk`/`drill-down` 类纯算法检索，召回失败时回退现有选择性 recall。
- [x] 测试同义词、跨来源合并、时间窗边界、实体冲突和 card/user 隔离。

## 记忆体优化专项拆解（优先执行）

目标：在不替换 Memory v3、不把摘要当事实、不扩大人格权限的前提下，让元元能“记得更有条理、查得更准确、说得出来源”。本节是上面 P1 记忆任务的执行顺序；完成一项再进入下一项。

### M0：建立当前记忆基线

- [x] 固定一组脱敏 fixture：用户偏好、人物关系、一次经历、一个承诺、同义表达、事实冲突、过期事实、私密回合和多 card 数据。
- [ ] 为每个 fixture 记录当前 recall 结果、延迟、字符数、误召回和来源字段，作为优化前基线。
- [ ] 明确验收指标：召回 P95、最大注入字符、无关召回率、纠错后旧事实使用率、删除后残留数。
- [x] 先写失败测试，确认新目标确实能暴露当前 FTS/标签召回的不足；当前已建立有界聚合基线测试，真实产品 fixture 仍待采集。

### M1：统一记忆来源卡片（先做数据契约）

- [x] 定义 `MemorySourceCard`：`sourceId`、`sourceType`、`scope`、`observedAt`、`validFrom/To`、`sensitivity`、`consent`、`excerpt`、`eventIds`。
- [ ] 将文字聊天、实时语音完成回合、fresh-topic observation、用户导入分别映射到该契约；文字聊天、实时语音完成 receipt 和显式确认的用户 Markdown/TXT 导入已接入，partial ASR/候选语音仍拒绝写入，fresh-topic 待接入验证。
- [x] 所有写入经过统一 sanitizer、scope 校验、幂等键和长度上限；保留原有 facts/episodes/commitments 表作为事实物化视图。
- [x] 测试重复写入、跨 card/user、private-session、敏感文本、过期来源和删除级联。

### M2：确定性分块与事件入队

- [x] 为长聊天/导入内容实现不依赖 LLM 的分块器：按 Unicode 字符边界切分，固定单块上限，保留前后时间和来源元数据。
- [x] 设计 content-addressed chunk id；同一内容重复导入不生成重复叶子，内容变化才生成新版本。
- [x] 将分块写入与 `memory_events`、`memory_jobs` 放在同一事务；失败时不能留下孤儿 chunk 或半条来源记录。
- [ ] 为 `extract_chunk`、`append_buffer`、`flush_stale` 增加 job lease、重试上限、取消和崩溃恢复测试；当前三者的纯算法/worker 基础与 extract_chunk 生命周期已完成，buffer 尚未接入真实导入流。

### M3：实体和主题索引（先纯算法）

- [x] 建立 canonical entity/alias 表及 scope 隔离 IPC，不调用 LLM 做唯一判定。
- [ ] 为 facts、episodes、commitments 和来源卡片建立可重建的 entity/topic 索引；索引损坏时可从事件重放恢复。
- [x] 实现 `memory_walk` 纯算法查询：实体 → 来源 → 时间窗 → 具体记忆，返回来源和冲突信息。
- [ ] 测试简称、错别字、同义词、跨来源合并、实体重命名、冲突事实、时间窗边界和硬上限。

### M4：摘要与召回离线评估

- [x] 已实现 source-level rolling summary；topic/global 仅作为可重建派生投影。
- [x] 摘要保留时间边界、事实冲突、来源引用和不确定性，不把推测改写成确定事实。
- [x] 已用固定 fixture 比较当前 recall 与摘要聚合的命中/字符成本差异；真实准确性门槛仍待设备数据。
- [ ] 摘要失败、超时、证据不足、过滤失败时必须回退现有 recall；在评估门槛通过前禁止进入真实聊天 prompt。

### M5：接入聊天和实时语音（灰度）

- [ ] 增加 feature flag，按 card/user 可单独开启；默认仍使用当前 Memory recall。
- [ ] 普通文字聊天先接 source/entity/time-window 过滤，再接摘要；注入内容保留“记忆观察”边界，不能覆盖 persona/system/skill 规则。
- [ ] 本地/CosyVoice 仅在既有 80ms/100ms 预算内接入结构化记忆卡片；火山端到端继续只用已验证的 session-start 能力。
- [ ] 绑定 generation/turn；barge-in、取消、旧回合和数据库故障的召回结果全部丢弃或回退。
- [ ] 测试记忆不可用、无当前话题、冲突、多卡切换、超时和 prompt injection；确认不影响音频时序。

### M6：用户管理、遗忘与可解释性

- [x] 在记忆列表中显示来源、时间和为何被召回，并保持敏感正文不展示；有效期/置信度/scope 的完整 UI 字段仍待补齐。
- [ ] 支持按来源、主题、实体、时间窗和记忆类型筛选；列表仍是删除/批量操作和无障碍主入口，图只做辅助。
- [ ] 删除或纠错后同步清理摘要、索引、图边、job、Activity 引用和召回缓存；提供事务化 rebuild derived。
- [ ] 增加“别记这段”“忘掉这件事”“仅本次使用”三种用户操作的端到端测试，验证重启后仍生效。
- [ ] 提供脱敏导出/备份和恢复前预览；当前仅保留脱敏导出、数据库备份与恢复，不提供文档导入。

### 记忆专项完成门槛

- [ ] 所有 M1–M6 行为测试通过，`npm run test:gate` 全绿；Memory 失败不阻塞普通聊天和实时通话。
- [ ] 事件、来源卡片、摘要、索引、图和缓存均可删除、重建、恢复，且没有第二事实库。
- [ ] 离线 fixture 达到既定准确性/遗漏/延迟门槛后才扩大灰度；没有评估证据的“更聪明召回”不得宣称完成。
- [ ] 至少完成一次 macOS 真实 App 验收；涉及本地语音记忆时，补做 Windows 真实服务与重启恢复验收。

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

## 补充待办：完成闭环前不可遗漏的工作

### 1. 先解决路线图与待办的状态漂移

当前 `roadmap-openhuman-adoption-implementation-2026-08-30.md` 写着 P0–P6 基础实现完成，但本文件仍把其中大量项目列为未完成；在继续开发前必须建立唯一状态来源。

- [ ] 为每个 P0–P8 条目补充 `状态/证据链接/最后验证日期/未完成原因`，区分“代码已存在”“已接入业务”“已通过测试”“已完成真实 App 验收”。
- [ ] 把已经实现但未接入真实入口的项目单独标为 `partial`，不能用文件存在代替用户可用。
- [ ] 每次发布只更新一个状态表，避免路线图和待办再次分叉。
- [ ] 对已有实现做一次重复能力扫描，确认没有第二套 goal/activity/capability/settings/memory store。

### 2. 核对 OpenHuman 版本漂移，避免实现过时设计

研究时发现 OpenHuman 的开发文档已说明 Global/Topic Tree 曾被移除，改为 Source Tree + entity index；因此当前“source → topic → global 摘要树”不能直接视为上游现行方案。

- [ ] 固定本项目采用的 OpenHuman 参考提交和文档快照，记录哪些结论来自历史设计、哪些来自当前实现。
- [ ] 在实现摘要树前比较三种方案：现有 Memory v3 投影、Source Tree + entity index、真正的多层摘要树；用离线 recall/冲突/删除测试决定，不因名称相似就照搬。
- [ ] 若保留 topic/global 投影，明确它们是可重建派生数据，不是第二事实库，并补充重建、删除、过期和 schema migration 测试。
- [ ] 每季度或每次上游版本升级重新核对许可证、依赖、文档和已移除能力。

### 3. 为“任务路由”补成本和容量闭环

- [ ] 为每个 task hint 定义输入/输出 token 上限、超时、并发上限、每日预算和 fallback 顺序。
- [ ] 区分“能力支持”与“当前资源可用”：模型支持 vision 不代表当前机器有显存或网络可用。
- [ ] 在 Activity/诊断中只记录固定的 token、耗时、provider 状态和 fallback 次数，不记录 prompt、回复或模型密钥。
- [ ] 测试路由递归、fallback 循环、预算耗尽、模型热切换和本地模式零网络请求。

### 4. 为持久化数据补版本、清理和隐私生命周期

- [ ] 为 activity、goals/TODO、turn snapshot、capability cache、run event ledger 分别定义 schema version、保留期和最大容量。
- [ ] 明确用户删除、清空 Memory、删除 card/user、卸载应用时各类派生数据如何级联清理。
- [ ] 增加“导出前预览”和“恢复前备份”测试，确认失败恢复不会覆盖新数据。
- [ ] 对崩溃中断、半写文件、磁盘满、权限改变、旧版本字段和未来版本字段做启动恢复测试。

### 5. 补齐 Activity/事件回放的并发语义

- [ ] 定义 operationId、generation、event offset 的作用域和生命周期，禁止跨用户/card/thread 重用。
- [ ] 明确事件顺序规则：重复、迟到、取消、重连、广播失败、进程重启时前端如何收敛到同一状态。
- [ ] 增加回放游标过期后的全量快照/重新同步路径，不能无限依赖旧 offset。
- [ ] 对 Activity 的“重试”建立一次性 operation token，避免按钮连点或重连导致重复执行。

### 6. 补齐用户可理解的控制面

- [ ] 每个后台能力提供暂停、恢复、立即运行、取消、忽略和清理入口；不可操作的状态显示固定原因。
- [ ] 为隐私模式、local-only、后台主动、目标提醒和外部操作审批分别提供独立开关，避免一个总开关造成误解。
- [ ] 设置页显示“数据存在哪里、何时过期、是否会联网、失败后是否自动重试”的短说明。
- [ ] 为关键按钮补键盘可达性、焦点状态、屏幕阅读器 label、中文错误文案和窄窗口布局测试。

### 7. 把安全评审和依赖审计列为发布门

- [ ] 建立 OpenHuman 借鉴清单：每个实现标注“独立实现/仅思想借鉴/待许可证审计”，禁止复制 GPL 代码片段进入 MIT 发行物。
- [ ] 对新增 Rust crate、Python wheel、模型和安装器资源做许可证、hash、来源和体积审计。
- [ ] 对所有外部操作执行路径做 threat model：prompt injection、路径穿越、符号链接、重放、重复点击和错误 fallback。
- [ ] 在 `npm run test:resources` 之外增加依赖清单和发布包扫描，确认没有意外打包 key、原始录音、PCM、测试 fixture 或上游源码。

### 8. 补真实使用数据再决定是否扩大范围

- [ ] 记录一小时典型使用的 CPU、内存、电量、磁盘增长、网络请求数、后台任务数量和首响延迟；只保留聚合值。
- [ ] 分别测量闲聊、图片理解、Memory 整理、本地语音、通话中后台 gate 的资源上限。
- [ ] 用真实 macOS/Windows 用户流程验证“可恢复”是否真的减少重复操作，而不是只验证数据库状态正确。
- [ ] 在这些数据出来前，不增加 OAuth/多渠道/自动屏幕观察/多级 agent fleet 等大范围功能。

## 明确不做

不复制 OpenHuman GPL 代码或依赖；不引入完整 TinyMemory/TinyAgents、自动观察屏幕/系统音频、OAuth 消息生态、远程 agent economy，也不允许外部观察或学习记忆修改 persona/system/skill 规则。
