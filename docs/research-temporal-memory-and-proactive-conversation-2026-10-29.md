# 时间记忆与自然主动对话调研（2026-10-29）

范围：调查“昨天晚饭被当成今晚”、QQ缺乏主动开口、桌宠主动性机械，以及多段消息体验。本文是研究与建议，不是功能已实施的声明；不创建新Goal、不修改产品、不提交或推送。代码以当前`codex/qq-one-switch`工作区为准，包含此前尚未提交的搜索／媒体修改。没有读取用户记忆库或私人聊天，没有向QQ发送测试消息。

## 1. 结论

建议先修“发生时间→整理→召回→模型阅读”的时间链路，再做有缘由的主动对话。否则主动性越强，越容易主动问错日期、重复已经结束的话题。

主动对话应区分三件事：**当前对话里还有话想补充**、**隔一阵回来关心一件具体事**、**获得了值得分享的新内容**。三者需要不同的触发、等待与过期规则。多段发送属于表达和投递，不应当成一次新的主动意图，也不应以固定概率再生成一整段话来模拟。

公开项目提供了可借鉴的工程机制，但没有证据足以证明哪个项目已达到“真人感”。建议组合：有时限的话题线索、允许不说的决策、真实素材、未回应退避、逐段取消与实际送达证据。保留当前SQLite、人格和语音播放合同，不为此迁移到全量Agent框架。

## 2. 当前时间问题：已有时钟，缺少完整的事件时间

### 2.1 源码证据

| 环节 | 当前行为 | 影响 |
|---|---|---|
| 当前时间 | `computeLiveContext`每轮注入年月日、星期与时分。[L1] | 单纯再加“今天日期”无法解决来源混淆。 |
| 原始消息 | `MemoryMessage`有id／role／content，无逐消息时间、来源时区。[L2] | 整理器不知道“今天／昨天／明天”相对于哪条消息。QQ最近8条历史也只保留role与content。 |
| 整理输入 | `process_job`按`[id] 用户/角色: 内容`格式化，没有消息时间或事件参考日期。[L3] | 昨晚消息今天才整理时，相对时间无法可靠消歧。 |
| 经历时间 | 普通整理的`occurred_at/created_at/updated_at`均使用处理时`now`。[L4] | 把记录时间当成事件发生时间；不是所有专用来源都这样，不能泛化至共同体验等所有写入路径。 |
| 临时事实 | `temporary`统一为处理后7天；未给validFrom时也用处理时间。[L5] | “今晚吃汉堡”几天后仍是可召回事实；有效状态与“现在正在发生”混淆。 |
| Rust召回 | 已返回`occurredAt`；对事实来自valid_from，对经历来自occurred_at，对约定来自due_at。[L6] | 同一个字段承载不同含义，不能一律渲染成“发生时间”。 |
| QQ提示 | 把召回项转为纯text后拼接；日期和kind都没有保留。[L7] | 库里有时间，模型阅读时仍然看不到。 |
| 桌宠／语音提示 | 通用observation只渲染kind、不确定、text；实时轻量卡片同样不保留时间。[L8] | 跨渠道会重复出现时态问题，不能只修QQ。 |
| QQ电话 | 独立桥启动只协商`turn-final-v1`等，未协商桌宠已有逐轮temporalContext；记忆映射也丢时间。[L9] | 仅会话开始有时钟；长通话跨日及事件来源仍需单独补齐，不能声称桌宠已有能力自动覆盖电话。 |

这不是对用户具体汉堡记录的数据库取证，但公开JS接收管线的合成探针已经确认：输入带`occurredAt`的昨日记忆，传给生成器的`memory`不含该日期；跨轮历史也无消息时间。探针调用真实导出模块、只使用合成数据；真实模型调用0、QQ发送0、Memory写入0。

### 2.2 建议的时间语义

至少区分以下时间，允许未知，不伪造精度：

- **消息时间**：用户什么时候说的，来自已验证QQ事件／应用接收时间／终态ASR时间；来源与时区明确。
- **事件时间**：事情什么时候发生，可能是时间段、日期或未知。“昨天晚饭”以那条消息时间解析，不能以worker重试时间解析。
- **记录时间**：何时整理、写入或修改，用于审计，不能当作用户经历时间。
- **状态有效期与约定到期**：偏好、正在做的事、一次性事件、未来计划分别处理。提醒到期、事实失效和历史遗忘不是同一概念。

建议的新输入保留原文与消息时间；提取结果增加事件时间范围、粒度、时态（过去／当前／计划／不明）、推断来源与置信度。先复用现有字段和事件日志，确实不足的部分做最小、可回放的schema扩展；不能由模型任意修改系统时间。

示例：10月28日19:30说“今晚吃了汉堡”，模型看到的内部线索应近似：

> 经历：用户在2026-10-28晚餐吃了汉堡；来自10月28日19:30的消息；相对当前为昨天，已经结束。这不代表今天的晚饭。

到29日可以自然说“昨天那个汉堡好吃吗”，但不能说“今晚的汉堡好吃吗”。到两周后除非话题相关，也不应反复主动问。事件依然可被历史查询找回，不应简单删掉。若原话是“昨天吃了汉堡”，事件日期应为27日；若是“明天打算吃汉堡”，只能记计划，不能隔天自动宣称已经吃了。

### 2.3 建议的落地顺序

1. **读侧止血**：统一日期／时区与记忆格式；显式区分发生、提及、有效和到期；跨日或长间隔给短历史加分界，旧摘要相对时间标为不明。提示“历史事件不等于当前状态”，未知时用“之前”或询问，不能只靠追加提示词代替数据。
2. **写侧闭环**：所有渠道补消息时间；事件按源消息解析；延迟整理与重试不能移动事件日期。处理时间继续独立保存。不让一轮吃饭、当时心情自动变成稳定偏好。
3. **时态召回**：支持今天／昨天／上周等过滤；稳定偏好与事件日期分开；过去事件可用于回忆，只有仍有效的状态才用于当下判断。索引相关性与时间约束共同决定结果。
4. **旧数据保守兼容**：有可靠事件／源消息证据才补时间；只有整理时间的记录保留“时间不明／记录于某日”，不批量猜发生日期，不自动清空旧事实。

Graphiti的双时间、事实有效窗口与失效保留，和LongMemEval的带时间会话、时间推理／更新／拒答评测，可用作设计与验收参照；不意味着需要引入Graphiti服务。[S1][S2] 当前项目已有部分valid-time和event日志基础，重点是补齐语义和传递。

## 3. 当前主动性为什么不自然

- **QQ没有独立主动入口**：`createQqPrivateChat`只暴露receive/invalidate，原生take_draft还要求近期主人消息对应nonce；不能靠启动计时器伪造一条用户消息来取得发送权限。[L7][L10]
- **桌宠续说是概率驱动**：默认0.5，按问句等调整；主回复后可能再请求一段followup。已有拆气泡，但“分段表达”和“产生新话题”仍混在体验里。[L11]
- **闲置分享限制较多**：90秒、时下功能开启、参与档位满足、聊天可见等；状态触发后本次运行不会再触发同一闲置分享。[L12] 隐藏桌宠时不会由此给QQ主动发消息。
- **实时通话已有更完整Director**：回应／展开／深入／联想、沉默期限、硬控制、预算与播放完成后计时；这是基础能力，不能为改善QQ而另起一套相互竞争的无限循环。[L13]
- **已有后台陪伴规格**：规定低频主动、未回应退场、发言权与播放证据，仍应沿用其产品边界。[L14]

## 4. “大肥鱼”与Coopanion源码核查

“大肥鱼”不是唯一可定位的项目名；以下两个候选都符合DeepSeek＋QQ描述。没有将其宣传、Star数或演示视频当作自然性实测结论。若用户后续提供确切仓库，应以确切目标再对照。

### 4.1 Aurabot：分段与调度拆开，主动内容仍偏随机

仓库[accomplish07zrh-eng/dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)，核对快照`716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa`。[S3]

- 每60秒tick；默认闲置40分钟、随机60～180分钟，每天最多4次、8～23点；允许`[沉默]`。
- 问题未答15～40分钟时50%概率追一句、同一问题只追一次。它不等于全局连续未答后停发。
- `|||`或换行分气泡，文字最多5段，长文／列表豁免；按字数约700～4500ms延迟、顺序发送。[S4]
- 可借：有限多段、不同表达共用一个意图、主动后可以不说。
- 不照搬：候选话题明确允许“今天遇到小事（编也行）”；未看到这条发送循环逐段检查新输入取消，不能宣称已支持插话撤回。虚构日常会制造假经历并污染记忆。

### 4.2 AstrBot版大肥鱼：真实活动与跨日线索更值得借鉴

仓库[whyever77/dafeiyu-astrbot](https://github.com/whyever77/dafeiyu-astrbot)，快照`c68d0df34f453942543838275e5ff15ef946c73f`；主动聊天依赖[Pancakes-Labs/astrbot_plugin_proactive_chat](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat)，依赖核查快照`2dab58514e0a2055400ed3bf7b3907ae684c0c54`。[S5][S6]

- 部署配方为120～240分钟、23～8点安静、连续2次未答暂停；依赖插件确实在锁内校验计数，发送后持久化，不只靠提示词。
- `df_share_thought`要求依据实际读到的内容，有具体感想才分享；有digest去重、预算与回执。新planner从未完目标、兴趣证据、冷却中选活动，允许休息；该层默认关闭，不能把源码存在写成已启用效果。[S7]
- 可借：真实阅读／活动→获得感想→值得分享才联系；跨日目标保存checkpoint。对本项目首版只用已有本地缓存、已授权结果或用户提供作品，自动浏览／后台搜索应作为后续独立能力讨论。
- 不照搬：无人回应时“失落困惑”的提示可能变成催回复；主动系统提示存为user/assistant pair不能当真实用户发言；任意一段发送成功不等于全部台词都已送达或已听见。

### 4.3 Coopanion：唤醒不等于必须开口

本次Coopanion快照`a84532dca639608728760c696b1da543f0008b9c`，其锁定Cortico为`a974d9e995d8df25fc2000cf31cc22a452ea16d3`，没有拿Cortico浮动HEAD冒充上游版本。[S8]

- heartbeat因外部活动重置；连续无外部活动，间隔指数退避到最多8倍；投递前重新检查节律，Agent可end_turn保持沉默。
- Agent可设置带理由的后续闹钟，用户可见、可取消；错过的唤醒携原计划时间。对聊天关心不能直接照搬“启动补投所有闹钟”，过期候选应丢弃或重新判断。[S9]
- `pet_say`支持多个动作／表情／气泡beat并给预计排队时间；预计播放时间不是本项目的真实播放完成回执，不可替代后者。[S10]

研究层面，Generative Agents展示了观察→记忆→反思→计划与主动互动的组合，但它是在模拟小镇里评估，不是QQ陪伴真人感或实际手机消息频率的证据。[S11]

## 5. 推荐方案：让每次主动开口有可说明的缘由

### 5.1 一个共享决策层，三类候选

| 类型 | 触发依据 | 合适的表现 | 不合适的表现 |
|---|---|---|---|
| 当轮补充 | 有一个尚未说完的观点、联想或小故事 | “对了，刚才那剧还有个细节……” | 每轮概率续说、每段都反问、等用户几秒就催。 |
| 后续关心 | 用户明确提过的、仍在合理时间窗口内的事情 | “你昨天说今天要面试，后来还顺利吗？”前提是日期与是否已问过可核对 | 把计划当已完成；隔几天重问“今晚汉堡”；未经邀请反复追问健康／敏感话题。 |
| 主动分享 | 与共同兴趣相关的真实资料、已完成活动或角色对既有话题的新看法 | “想到你之前说喜欢悬疑，这个设定你可能会感兴趣。” | 伪造刚看完电影、刚吃完饭、假装一直观察主人。 |

候选存为有界的临时对话状态：scope、类型、真实来源、事件时间、最早／最晚时机、重复指纹、已经问过没有、状态（候选／暂缓／已发／取消／过期）。这是“待续的话题”，不是自动生成新的用户事实或强制提醒；用户没答也不推断其生气、忙碌或关系下降。

### 5.2 模型选内容，程序决定能否发送

建议先做廉价准入，再让模型在少量候选中返回`send / wait / drop`。没有价值可drop；暂时不合适可wait；不能只让模型输出“想说”就绕过限额。

准入包括：用户允许、安静时段、是否正在回复／通话、最近是否已主动、日预算、相同话题冷却、候选有没有过期、人格与昵称是否仍一致。QQ常规私聊不能假设有已读／可靠在线／正在输入状态；仅能使用真实收到和送达的证据。

调度持久化在原生进程，WebView隐藏不会使QQ停摆；桌宠、QQ与电话共用一次主动的预算与去重，避免三处同时问候。每个渠道保留自己的发言时机，电话仍以播放完成为时钟起点；不改VAD／ASR端点来制造“主动”。

### 5.3 建议试用的节奏，不是已验证最佳参数

- 当前积极聊天：先试1～3条有内容的短段，必要时一条长答；是否补充由内容需要决定。
- 跨时段主动：有强理由才进入候选；没有强理由时，试用60～180分钟的检查／最早发送窗口，而不是到点必发；普通社交主动先试每天最多2～4次，可在设置调低／关闭。
- 一次未回应后延长等待；连续两次未回应暂停普通社交主动，用户发言后恢复。用户明确设置的提醒单独管理，不与“无人回应就不聊”混同。
- “安静一会儿”、夜间、下线后不补发过期候选。没有平台已读不能说“你看到了怎么不回”。

默认值需通过本人的实际体验调整，不能宣称这些分钟数比现有方案更像真人。允许选择偏好：安静／自然／更主动；不要让用户配置十多个内部概率。

### 5.4 多段发送：是一个回合，能够被插话打断

生成一份有界段落计划，按语义分1～3段，不固定一逗号一条。段间可有少量字数相关等待；用户新消息到达，取消尚未发送的段，后续回复基于实际已经送达部分；不必等待完整“演完”再回答。

每段有`intentId + segmentId`、顺序、当前scope/lease与回执。发送结果未知不自动重发；只把真实送达的段放进短历史和记忆来源。原生现有nonce只能消费一次，需设计独立的主人限定主动准入／多段账本，而不是解除验证或伪造用户消息。主动候选与隐藏控制提示不作为用户内容落库。

语音模式先保留既有“语音或独立表情”互斥。多条语音是否自然、延迟是否可接受应单独试听，首版可先开放文字多段、语音一条；电话仍按已有实际播放完成账本，不把QQ发送成功当对方听完。

## 6. 推荐实施批次与验收

| 顺序 | 范围 | 验收重点 |
|---|---|---|
| P0 | 时间读侧＋源消息时间＋事件时间写侧 | 28日汉堡29日不说今晚；“昨天／明天”以消息时间解析；跨日短历史、重试、时区、未知日期、旧数据兼容。 |
| P1 | 一轮有界文字多段＋逐段取消 | 不强制每轮拆；主人插话取消剩余；已发与未知回执区别；仅实际发送的片段入历史／Memory。 |
| P2 | 带缘由的主动候选、等待／放弃决策、原生主人限定发送 | 隐藏窗口仍可运行；未完成话题能主动关心；已问不再问；无素材保持沉默；2次未答退避；多渠道不重复。 |
| P3 | 兴趣活动、真实资料分享与跨日延续 | 单独确定是否允许后台联网／阅读，再做有界活动预算与真实经历；不虚构“生活”，不把外部正文写成用户事实。 |

自然性验收应回放真实对话，不能只断言策略枚举变化。建议记录：时间指代错误、已结束事项误当当前、重复话题、主动消息被接住的情况、无人回应后的追加、取消漏发、主动中问句占比，以及用户主观“像朋友／像客服／像催回复”的评价。参与率不等于真实感，也不能靠催回复提高。

数据先用合成场景；真实会话评价须由用户自愿提供／确认使用，不自动导出私聊。自动测试按仓库Red→Green与完整gate；原生调度、睡眠恢复、QQ收发、语音播放必须分渠道实机验收。本次仅文档研究，未运行功能门禁、未修改时间记忆或主动发言功能。

## 7. 来源

本地源码引用针对当前未提交工作区，行号可能随后续实现变化。

- [L1 当前时间注入](../src/ai/persona.js#L1080)、[L2 消息与召回结构](../src-tauri/src/memory.rs#L898)、[L3 普通巩固输入](../src-tauri/src/memory.rs#L4956)、[L4 经历插入](../src-tauri/src/memory.rs#L5076)、[L5 临时事实期限](../src-tauri/src/memory.rs#L5488)、[L6 召回候选](../src-tauri/src/memory.rs#L3606)。
- [L7 QQ私聊管线](../src/ai/qq-private-chat.js#L74)、[L8 桌宠观察格式](../src/ai/observation.js#L30)与[实时记忆格式](../src/realtime-memory.js#L98)、[L9 电话上下文](../src-tauri/src/qq_phone.rs#L988)、[电话召回映射](../src-tauri/src/qq_phone.rs#L1207)、[L10 原生发送准入](../src-tauri/src/qq.rs#L451)。
- [L11 概率续说与拆分](../src/ai/persona.js#L1177)、[L12 闲置状态](../src/ai/fresh-idle.js#L1)与[桌宠接线](../src/chat.js#L494)、[L13 Director](../src/ai/conversation-director.js#L347)、[L14 后台陪伴规格](./spec-background-companion-call.md)。
- [S1 Graphiti README，72b5c59](https://github.com/getzep/graphiti/blob/72b5c59c06607e09ea855be61b6ff5a3446fc951/README.md#L121)、[实际时间字段](https://github.com/getzep/graphiti/blob/72b5c59c06607e09ea855be61b6ff5a3446fc951/graphiti_core/edges.py#L271)。这里只借鉴概念，不把其宣传性能当本项目测量。
- [S2 LongMemEval论文](https://arxiv.org/abs/2410.10813)、[带时间评测数据格式，9e0b455](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md#L81)。
- [S3 Aurabot主动机制](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa/src/features/companion.js#L143)、[默认配置](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa/src/core/config.js#L161)。
- [S4 Aurabot气泡解析](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa/src/chat/reply.js#L42)、[节奏](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa/src/chat/reply.js#L143)、[投递循环](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/716bfe9719c29ed6f9a4eb1b7a79376fdd34baaa/src/chat/hub.js#L599)。
- [S5 AstrBot大肥鱼部署配方](https://github.com/whyever77/dafeiyu-astrbot/blob/c68d0df34f453942543838275e5ff15ef946c73f/docs/部署指南.md#L65)、[S6 依赖插件未答门控](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/2dab58514e0a2055400ed3bf7b3907ae684c0c54/core/features/gating_feature.py#L58)、[发送后计数](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/2dab58514e0a2055400ed3bf7b3907ae684c0c54/core/pipeline/flow_orchestrator.py#L218)、[分段发送](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/2dab58514e0a2055400ed3bf7b3907ae684c0c54/core/services/sender_service.py#L457)。
- [S7 活动分享](https://github.com/whyever77/dafeiyu-astrbot/blob/c68d0df34f453942543838275e5ff15ef946c73f/plugin/astrbot_plugin_bili_activity/main.py#L1750)、[活动planner](https://github.com/whyever77/dafeiyu-astrbot/blob/c68d0df34f453942543838275e5ff15ef946c73f/plugin/astrbot_plugin_bili_activity/planner.py#L78)、[作者区分已实现与待验收的方案](https://github.com/whyever77/dafeiyu-astrbot/blob/c68d0df34f453942543838275e5ff15ef946c73f/docs/自主生活开发方案.md#L3)。
- [S8 Cortico锁定heartbeat](https://github.com/Pal-AI-Lab/Cortico/blob/a974d9e995d8df25fc2000cf31cc22a452ea16d3/bots/cormini/persona/heartbeat.ts#L26)、[内部唤醒接线](https://github.com/Pal-AI-Lab/Cortico/blob/a974d9e995d8df25fc2000cf31cc22a452ea16d3/bots/cormini/persona/persona.ts#L302)、[Coopanion外部活动接线](https://github.com/Pal-AI-Lab/Coopanion/blob/a84532dca639608728760c696b1da543f0008b9c/core/persona.ts#L233)。
- [S9 带原因的未来唤醒](https://github.com/Pal-AI-Lab/Coopanion/blob/a84532dca639608728760c696b1da543f0008b9c/core/alarms.ts#L148)、[S10 多beat工具](https://github.com/Pal-AI-Lab/Coopanion/blob/a84532dca639608728760c696b1da543f0008b9c/packages/cortico-world-desktop-pet/src/tools.ts#L17)、[实际实现](https://github.com/Pal-AI-Lab/Coopanion/blob/a84532dca639608728760c696b1da543f0008b9c/packages/cortico-world-desktop-pet/src/world.ts#L1749)。
- [S11 Generative Agents原论文](https://arxiv.org/abs/2304.03442)、[作者开源实现](https://github.com/joonspk-research/generative_agents)。
