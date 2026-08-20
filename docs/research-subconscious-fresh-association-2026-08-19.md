# 潜意识联想 × 时下信息：Memory Brain 扩展设计

> 日期：2026-08-19
> 上游项目：[Square-Q/subconscious-skill](https://github.com/Square-Q/subconscious-skill)
> 固定上游快照：[`06f8cf2a777cf7e5a4de86a766d08e58c044503c`](https://github.com/Square-Q/subconscious-skill/tree/06f8cf2a777cf7e5a4de86a766d08e58c044503c)
> 相关前置调研：[subconscious-skill 接入 Memory Brain 的效果与边界](./research-subconscious-skill-memory-brain-2026-08-19.md)

## 结论

最值得做的不是让元元“记住互联网”，而是增加一层 **Fresh Association（时下联想）**：把短期 Fresh Topics、当前对话和现有 Memory/Graph 同时作为候选，在 Workspace 中竞争，选出至多一条能自然说出口的联想。

它可以产生三种有价值的体验：

1. **顺着眼前的话自然带出新内容**：“你一说联机，我想起来最近刷到一个新游，那个美术还挺特别。”
2. **把新内容和共同记忆接起来**：“之前你不是说更喜欢慢慢探索嘛，最近那个 XXX 看着还挺对你胃口。”
3. **低频地主动分享**：“我跟你说，我最近看到个挺好玩的事……”

这里的“最近看到”只能表示系统收到并筛过一条有来源的短观察，不能暗示角色看完电影、玩过游戏、读过全文或亲历事件。现有 Fresh Topics prompt 已明确要求“不声称亲自看过全文”、只挑最相关一条、用户不感兴趣就换题，这应继续作为表达底线。[Fresh Topics 前端边界](../src/ai/fresh-topics.js)

推荐把该能力纳入 **Memory Brain M4-E：Subconscious Replay / Fresh Association**，但保持以下架构边界：

- 外部内容只存在于 Fresh Topic cache 和当轮 Workspace，不进入 Memory、Graph、recap、persona 或诊断正文；
- Memory 只提供“为什么这条可能与用户有关”的私人语境，不被发给启动预取来源；
- 联想是 `derived` 临时候选，不是事实，不自动创建 graph edge；
- 文字聊天先上线并做 shadow/反馈评估，实时语音最后接入；
- Workspace 与新鲜话题观察仍由用户分别显式开启，关闭任一开关都能完整回退。

## 1. 现有能力与真正缺口

### 1.1 已经具备的地基

本项目不需要复制上游的 JSON 记忆库或五阶段 Python 管道。

- Memory v3/v3.1 已有 SQLite 事件、evidence、scope、事实冲突/替代、commitment、Graph、清除与恢复；Workspace 已能组合当前消息、召回、pending commitment、1–2 跳图扩散和安全候选。[Memory Brain 路线图 M4](./roadmap-memory-brain.md#M4Global-Workspace--涌现联想实验)
- `WorkspaceCandidate` 已包含 activation、relevance、novelty、utility、uncertainty、scope、expiresAt，经过分数门槛、相似去重和 4/5/6 槽位限制；`hypothesis` 至少需要两个证据来源和一条反证/待验证条件，且不会自动升级为 fact。[Workspace 实现](../src/workspace.js)
- Fresh Topic cache 已是独立、短期、有界的外部观察层：15 个固定来源、6 小时 provider TTL、7 天条目过期、最多 200 条缓存；对话最多注入 3 条，每条 300 字、整块 1200 字。[实时对话规格 16.1](./spec-realtime-conversation-v2.md#161-新鲜互联网话题预取与统一缓存代码已实现待测试版验收) [Fresh Topics 实现](../src/ai/fresh-topics.js)
- 文字聊天已有 `relevant / occasional / active` 三档。后两档每 6 / 3 个合适的**用户回合**尝试一次 ambient 线索，并在已有对话且持续 90 秒静默时最多触发一次独立 idle share；两者都受严肃上下文、输入/媒体/通话和可见性门控。`proactiveKind` 会绕过普通 ambient 计数。同一 `sourceId` 只有当前会话内最多 16 项的冷却集合，App 重启/新会话后仍可能再次出现。[文字聊天采样与 proactive 分支](../src/chat.js) [会话冷却实现](../src/ai/fresh-topics.js)
- 实时语音只有本地/CosyVoice 显式协商 `fresh-topic-v1` 后才能消费时下话题，旧服务与 Volcano 不注入；现有 `proactive-topic` 路径已经会抓取 fresh topics 并随逐轮 context 发送，不需要另造第二条主动话题通道。主动轮数、话题队列、打断和播放回执也已有固定上限。[实时对话规格](./spec-realtime-conversation-v2.md) [通话逐轮 fresh topic 获取](../src/chat.js) [实时协议适配](../src/ai/realtime.js)
- Tavily 只处理用户明确的当前信息/搜索意图，使用固定 HTTPS endpoint、basic search、4 条结果、4 秒上游超时，并关闭 answer/raw content/image；未知或未配置 provider 失败关闭。[Web observation 前端](../src/ai/web-observations.js) [本地代理](../src-tauri/src/api.rs)

### 1.2 当前缺口

当前文字路径把 Memory Workspace 与 Fresh Topics 分别渲染后拼进 system prompt；两者没有一个共同选择器来回答“为什么偏偏现在提这条”。Fresh Topic 的 Rust `query()` 在有类别时会让 `!categories.is_empty()` 直接满足 `query_matches`，所以**类别内所有条目都视为 query match**，之后主要按发布时间/抓取时间排序；它没有实现类别内 query-to-item relevance ranking。通用请求则使用固定类别顺序。路线图也明确记录：查询词到具体条目的细粒度相关性排名仍是后续优化，不能把类别匹配宣称为已完成的语义排序。[Rust `FreshTopicService::query`](../src-tauri/src/fresh_topics.rs) [当前实现边界](./spec-realtime-conversation-v2.md#161-新鲜互联网话题预取与统一缓存代码已实现待测试版验收)

调研时设置页说明仍写“中立 6 条、感兴趣 10 条、不主动聊 0 条”，与 Rust 和权威规格的 `10 / 15 / 0` 不一致；2026-08-20 的实现切片已同步修正文案。曝光率与候选池评估统一以 `10 / 15 / 0` 为准。[设置页文案](../src/settings.html) [权威规格配额](./spec-realtime-conversation-v2.md#161-新鲜互联网话题预取与统一缓存代码已实现待测试版验收)

因此缺少的是一层**对话级导演**：

- 判断当前是否适合插入新话题，而不只是“轮数到了”；
- 从网页线索中选出最能与当前消息、近期兴趣或旧经历接上的一条；
- 决定用回应、联想、推荐、主动分享还是不说；
- 记录“提过、被拒绝、已深入聊过”，避免跨回合反复播报；
- 保持外部观察和长期记忆的数据生命周期完全分离。

## 2. 从 `subconscious-skill` 吸收什么

上游最有启发性的不是存储，而是四个产品机制。

### 2.1 后台 replay，而不是每轮只做 query recall

上游在会话结束后执行编码、联想、凝缩和固化，并在下次会话给出最多三条 whisper。这证明“没有当前查询时也生成候选”能带来意外联想；但它的候选顺序是近期 insight、全局重要记忆和本轮高分记忆，并不根据下个会话的具体问题选择。[上游候选生成](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/subconscious.py#L179-L232) [whisper 选择](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/whisper.py#L57-L91)

可吸收：在空闲期准备小型候选池。不能照搬：每次开场固定注入三条。元元应在真正回复前重新按当前情境竞争，最多说一条，也允许一条都不说。

### 2.2 关系激活与弱联想

上游 associator 用标签、标题关键词和项目做字符串关联；dream 又通过共同标签建立 `symbolic` / `temporal` 弱边，并随机展示不同类型记忆的组合。[associator](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/associator.py#L49-L92) [dream](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/dream.py#L41-L79)

可吸收：允许“新电影 -> 用户喜欢的类型 -> 以前一起聊过的角色”形成一次跳接。不能照搬：共同宽标签或随机配对不能证明关系，更不能写 Graph。外部条目只能作为当轮激活种子，输出 `derived:true`、高 uncertainty 的临时联想。

### 2.3 凝缩与模式候选

上游会把共享标签的记忆聚类为 insight，并用固定模板识别少数重复行为。[consolidator](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/consolidator.py#L38-L139) [patterns](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/patterns.py#L39-L100)

可吸收：跨不同 episode 发现“最近反复聊游戏”“几次都对科幻电影有兴趣”这类短期兴趣信号，让新内容更容易激活。不能照搬：网页点击、模型之前推荐过、用户沉默或一次短回应都不能自动变成稳定偏好；只有用户明确表达的喜欢/不喜欢才可按现有偏好候选路径保存。

### 2.4 激活衰减与抗重复

上游有重要性、引用增强、pin 与遗忘概念，但实际衰减是每次管道运行固定减 `0.05`，不是按真实时间，也会因聊天频繁而更快归档。[importance](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/importance.py#L13-L24) [衰减实现](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/importance.py#L74-L78)

可吸收：候选被使用后降低 novelty，长期未使用的普通联想降低竞争力。不能照搬：衰减只改变临时候选的排名，不归档/删除事实、episode、置顶项或 commitment；时钟使用真实时间差，不能使用会话次数。

## 3. 推荐数据模型：双来源、单次联想

第一版不建新表。把新机制定义为纯函数生成的短期对象：

```ts
type FreshAssociationCandidate = {
  id: string;                    // 会话内随机/不透明 id
  kind: "fresh-association";
  move: "bridge" | "share" | "recommend" | "ask";
  freshSourceId: string;         // 只在 Fresh Topic 层和当前会话使用
  freshCategory: string;
  freshPublishedAt?: string;
  memorySourceIds: string[];     // 0--3 个，仍受 card/user scope 限制
  evidenceKinds: ("current-message" | "explicit-preference" |
                  "episode" | "topic" | "commitment")[];
  associationReason: "direct-topic" | "preference-match" |
                     "episode-echo" | "ambient-discovery";
  activation: number;
  relevance: number;
  novelty: number;
  utility: number;
  uncertainty: number;
  expiresAt: number;             // 不超过 fresh item 自身过期时间
  derived: true;
};
```

`content` 不应由后台模型自由生成并持久化。真正进入 prompt 时，渲染器临时组合两块独立 observation：

```text
外部短观察：来源、标题、发布时间/抓取时间、短摘要、URL
私人关联理由：当前话题 / 明确兴趣 / 某个旧 episode 的有界摘要
表达策略：bridge | share | recommend | ask
```

模型可以把两块写成自然语言，但不能据此创建“用户喜欢 XXX”或“元元看过 XXX”的事实。外部 source 与 Memory source 只是同一轮的联合证据，不产生持久 cross-edge。

### 3.1 生命周期

```text
FreshTopic cache（外部、短期、最多 7 天）
        +
当前消息 / Memory recall / Workspace slots（当前 user/card scope）
        |
        v
deterministic pairing + scoring
        |
        v
FreshAssociationCandidate（内存、分钟级）
        |
   gate: 情境适合？分数够？未冷却？
        |
        +--> 不说：直接丢弃
        |
        +--> 当轮最多 1 条 observation
                 |
                 +--> 用户明确表达兴趣/反感：只保存用户自己的偏好事件
                 +--> 普通追问：留在聊天 history，不把网页正文写 Memory
                 +--> 外部条目过期/删除：候选失效
```

任何依赖外部条目的候选必须取 `min(candidateTTL, freshItemExpiresAt)`。删除、过期或 sourceId 不再存在时，候选立即不可重建。Memory scope 清除后，相关联想也必须失去私人关联理由。

## 4. 候选生成与排序

### 4.1 先做硬门槛

满足任一情况才允许生成：

- 当前消息显式命中具体类别或 discovery/current-info intent；
- 用户有手动或明确推断的该类别 `interested` 偏好；
- 一个有效 episode/topic/entity 与 fresh item 有具体实体或细分类标签重合；
- ambient 档位到点，且当前是轻松闲聊、不是任务执行/报错/安慰/隐私/医疗财务等严肃情境。

以下情况直接不说：

- 第一人称近况陈述只因为含“最近”而命中；当前实现已经专门排除了这类误触发，应保留。[Fresh intent 分类](../src/ai/fresh-topics.js)
- 用户在纠错、拒绝、说“别聊这个”、追问上一答复的细节或要求简短；
- 候选只有 `daily-life/work` 这类宽标签，没有实体、明确偏好或具体行为证据；
- 外部 item 缺来源、时间、HTTPS URL、摘要，或 sanitizer 拒绝；
- 同一来源、事件族、实体或话题仍处于冷却期；
- Memory 候选敏感、冲突、superseded、expired 或跨 scope。

### 4.2 建议分数

沿用 Workspace 的可解释分量，新增“个人桥接”和“疲劳”而不是另做 embedding 黑箱：

```text
score = 0.27 * currentRelevance
      + 0.18 * personalBridge
      + 0.14 * sourceFreshness
      + 0.13 * novelty
      + 0.10 * conversationalFit
      + 0.08 * sourceQuality
      + 0.06 * diversity
      + 0.04 * utility
      - 0.18 * topicFatigue
      - 0.15 * uncertainty
```

分量建议：

| 分量 | 可验证输入 | 注意 |
|---|---|---|
| `currentRelevance` | 类别、实体、标题/摘要 token 与当前消息 | 第一版只做规则；不能宣称语义排序 |
| `personalBridge` | 手动兴趣 > 用户明确推断兴趣 > episode/topic 弱关联 | 网页文本绝不能作为用户偏好证据 |
| `sourceFreshness` | `publishedAt` 优先，否则 `fetchedAt` | 抓取时间不能冒充发布时间 |
| `novelty` | source/event/entity 最近是否提过 | “模型是否采用”不可观测时按 offered 计更保守 |
| `conversationalFit` | 当前 move、情绪、是否任务态、回复长度要求 | 严肃情境为硬 veto，不只扣分 |
| `sourceQuality` | 固定 adapter、字段完整、专业源优先级 | 不推断商业授权或绝对可信度 |
| `diversity` | 最近话题类别、来源、事件族 | 防止连续都是游戏/同一热搜 |
| `topicFatigue` | offered/rejected/discussed 次数与时间差 | 用户拒绝权重大于自然过期 |
| `uncertainty` | 只有 fetchedAt、摘要缺失、宽标签桥接 | 高不确定不得用肯定语气 |

选择过程先按 hard gate 过滤，再按 score 排序，再做 max-marginal-relevance 式去重：与近期已提实体、事件族或类别过近的条目降低优先级。最终**每轮最多一个、每个主动 turn 最多一个**，没有超过阈值的候选就不注入。

### 4.3 三层防重复

1. **Source cooldown**：保留现有会话内 `sourceId` 集合；从“拿到结果即消耗”调整为按 `offered` 记账，但启动欢迎阶段仍不能提前消耗未真正提供给模型的条目。
2. **Semantic fatigue**：对规范化实体、事件族、类别分别保留小型环形队列。即使不同来源报道同一电影/游戏，也只视为一个话题族。
3. **Interaction outcome**：固定枚举 `ignored | engaged | rejected | discussed`。`rejected` 进入最长冷却；`engaged` 允许当前对话继续，但不重新注入整条 observation；`discussed` 在本次会话封题。

第一阶段所有账本仅在会话内存中，和现有 16 项 source cooldown 一样有界。若真人测试仍出现重启后重复，第二阶段可在 `fresh-topics-v1.json` 旁增加**独立于 Memory**的有界 exposure metadata，只保存 source/event 的不透明摘要、固定 outcome 和时间，不保存标题、正文、用户原话、Memory ID，也不进入诊断导出。不要为了跨会话去重把网页内容写进 `memory-v3.sqlite3`。

## 5. 自然表达：让“看到了”听起来像角色，不像新闻播报

### 5.1 四种 move

| Move | 触发 | 合适表达 | 禁止 |
|---|---|---|---|
| `bridge` | 当前话题直接相关 | “你一说这个，我想起最近刷到……” | 突然换题、逐字念标题 |
| `recommend` | 有明确兴趣桥，且用户在找内容 | “感觉这个可能挺对你胃口……” | 把推测说成已知喜好 |
| `share` | ambient/主动分享且情境轻松 | “我跟你说，最近看到个挺好玩的事……” | “根据最新消息，以下是……” |
| `ask` | 弱关联、高 uncertainty | “那个 XXX 最近好像挺火，你听说过没？” | 假装自己看完/玩过后评价细节 |

### 5.2 事实姿态

可以说：

- “最近刷到一个关于 XXX 的消息……”
- “XXX 最近好像挺多人在聊，我只看到个介绍……”
- “看着有点像你之前提过的那类，不过我还不敢说一定适合你。”

不应说：

- “我昨天看完这部电影了。”
- “我玩了十几个小时，手感很好。”
- “大家都说/全网都在讨论。”（单一来源不能推出全网热度）
- “你肯定喜欢。”（Memory 联想不是确定偏好）

“很火”需要额外证据门槛：热榜/榜单源的显式排名，或至少两个独立 source family 在短窗口内指向同一实体。单个新游、新片列表只能说“最近出了/我刷到”，不能说“很火”。这比依赖模型从标题猜热度更可测。

建议把可说的事实姿态做成 claim-level 枚举，而不是仅靠 prompt：

| `claimLevel` | 最低证据 | 允许措辞 |
|---|---|---|
| `seen-snippet` | 一条完整、未过期的 source observation | “刷到/看到个介绍/看到有人提” |
| `recent-release` | source 明确给出发布日期/上架时间 | “最近出了/刚上架” |
| `ranked` | 固定榜单源含可验证排名 | “在 XXX 榜上排到……” |
| `multi-source-buzz` | 两个独立 source family、同实体、短时间窗 | “最近好像不少人在聊” |

渲染器只把证据支持的最高等级交给模型，缺证据就降到 `seen-snippet`。任何等级都不允许生成“我看完了/我玩过”。

### 5.3 不使用固定开场白轮播

不应把“我跟你说，最近看到个好玩的事”做成每三轮固定模板。渲染层只给 move、事实姿态和禁止项，让角色模型在现有人设范围内变化表达；同时可用纯规则检查以下反模式：

- 连续两次相同 8–12 字开头；
- “根据/据报道/以下/为你推荐”式播报腔；
- 标题整句复读；
- 先说外部内容、后回应用户；
- 每次都以问题结尾；
- 用户追问时重新自我介绍或复述完整观察。

现有 Fresh Topic prompt 已要求“先接住用户，再用半句自己的反应或好奇带出话头，最后留轻接球”，也要求追问只答新增部分；新导演应继承而不是另写冲突规则。[Fresh Topic prompt](../src/ai/fresh-topics.js)

## 6. 隐私、注入与记忆治理

### 6.1 信息流只能单向汇合

```text
固定 provider -> Fresh Topic cache -> 本地配对器
                                      ^
Memory scoped snapshot ---------------|
```

Memory、persona、聊天文本、设备信息不得发送给启动 provider。地点/职业继续只允许现有规范化短标签入口；前端最多发送三个城市、两个职业标签，不发送来源文本。[Fresh Topics 推断实现](../src/ai/fresh-topics.js) [来源与地点边界](./research-fresh-web-topics-2026-08-08.md)

Tavily 仍只用于用户明确搜索意图，不用于后台“潜意识漫游”。否则会把用户私密记忆转成外部搜索 query，直接违反当前 provider-neutral observation 边界。

### 6.2 外部内容永远是不可信 observation

- 标题、摘要、来源名都经过长度限制、标签/页面操作词与 prompt-injection sanitizer；
- 外部内容不能修改 persona、system、skill、工具权限、Memory 规则或导演阈值；
- pairing 模块只读取清洗后的固定字段，不读取网页全文；
- 外部文本不进入 Memory consolidation、recap、诊断、日志或话题偏好 evidence；
- 用户随后明确说“我喜欢这种游戏”时，只保存这句用户表达形成的偏好事件，不把网页摘要复制为证据；
- 诊断只记录候选数、veto 原因枚举、move、分数 bucket、延迟和 outcome 计数，不记录 sourceId、标题、URL、topic/entity、Memory ID 或正文。

### 6.3 联想不能自我强化

“模型提过 -> 用户没反对 -> 用户喜欢”是无效链路。只有用户明确表达、手动设置或现有经过审核的分类器能提供 personalBridge。助手自己生成的推荐、网页曝光次数、沉默、窗口关闭、播放完成都不能作为兴趣证据。

同理，`fresh item <-> memory` 的临时配对不能新建 Graph edge。只有用户在后续对话中自己建立关系，例如“这个导演就是我之前喜欢的那位”，才由正常 Memory 事件/巩固路径处理。

## 7. 文字与语音的不同 rollout

### Phase A：离线 shadow evaluator

只生成和打分，不改变回复。固定语料至少覆盖：

- 当前相关、旧兴趣相关、纯 ambient、严肃任务、安慰场景、用户拒绝、连续追问；
- 同一电影多来源、同类不同实体、来源时间缺失、条目过期；
- 跨 nickname/card scope、敏感 Memory、冲突事实、已删除 source；
- prompt injection 标题/摘要、超长内容、非 HTTPS/带凭据 URL；
- “我最近在看书”不应因“最近”触发 ambient 新闻。

输出只有固定候选结构和无文本指标。

### Phase B：文字聊天、只做响应式 bridge

- 要求 `webGroundingEnabled && memoryWorkspace`，默认关闭；
- 只在用户当前消息有直接类别/discovery intent 时运行；
- 每轮最多一条，必须先回应用户；
- 不做主动开场，不持久化 exposure ledger；
- 在设置或 debug 构建中提供“有用 / 不相关 / 别再聊这个”的反馈入口。

文字先行的理由是可以查看完整上下文、低成本打断、容易收集明确反馈，也不会把错误联想直接变成不可撤回的音频。

### Phase C：文字 ambient 分享

在 Phase B 的无关率与拒绝恢复通过后，才接 `occasional / active`。除了现有 6/3 回合计数，还要增加情境 veto、semantic fatigue 和固定主动预算：

- 每个文字会话 ambient 最多 1 次；
- 用户拒绝后该类别本会话为 0；
- 严肃/任务态连续至少两轮后才重新具备资格；
- 若没有高于阈值的候选，轮数到点也保持沉默。

### Phase D：跨会话 replay

空闲期只生成有界 candidate fingerprints，不调用外部搜索、不写 Memory。下次会话仍要结合第一条用户消息重新排名；没有合适入口就过期。只有真人测试证明“重启后重复”是主要问题，才增加独立 exposure metadata。

### Phase E：本地/CosyVoice 实时语音

语音最后接入，并继续要求 `managed-v1 + local-v1 + fresh-topic-v1` 协商。不要为 Volcano 推断支持，也不要改其协议常量。额外门槛：

- 候选选择必须在现有缓存命中路径完成，不新增外部请求或可感知 TTFA；
- 只在已完成播放回执后启动的主动 turn 使用，用户 speech candidate 立即取消；
- 每通通话最多一次 fresh share，计入现有最多三次连续 proactive turn，而不是另开预算；
- `rejected/redirect/pause` 立即封题，`resume` 也不能绕过 source/topic cooldown；
- 诊断继续只留固定计数和枚举，不含网页/Memory/topic 正文；
- Volcano、旧本地服务、未协商服务全部降级为无该能力。

## 8. 测试与评估

### 8.1 确定性合同测试

| 维度 | 必须满足 |
|---|---|
| 有界性 | 每轮 ≤1 联想；输入、候选、队列、冷却均固定上限 |
| 幂等 | 相同 snapshot + time bucket 产生相同排序/fingerprint |
| scope | nickname/card/user 跨域泄漏为 0 |
| 生命周期 | fresh item 过期/删除后相关候选为 0 |
| 注入 | 恶意标题/摘要不得成为指令或修改策略 |
| 记忆污染 | 外部标题/摘要/URL 进入 Memory、recap、diagnostic 为 0 |
| 反重复 | 同 source、事件族、实体在冷却期内重复输出为 0 |
| 拒绝 | `rejected` 后本会话同类主动候选为 0 |
| 热度表述 | 无榜单或多来源证据时不得生成“很火”姿态 |
| 降级 | cache 空、provider 错误、Workspace 关、协议未协商时普通对话不受阻塞 |

JS/Rust/Python 镜像的固定枚举和协议字段必须表驱动一起测试。不要快照完整 prompt 或自然语言全文；测试 move、veto、source count、score bucket、冷却和 observation 字段即可。

### 8.2 离线内容评估

人工标注固定中文对话集，分别衡量：

- `precision@1`：被选条目是否真的适合此刻提；
- `bridge validity`：私人记忆与外部条目的关联是否有证据；
- `intrusion rate`：任务/严肃语境中错误插入率；
- `unsupported popularity rate`：无证据却说“很火”的比例；
- `persona overclaim rate`：声称看完/玩过/亲历的比例；
- `repeat fatigue rate`：相邻 10 回合出现同实体/事件族的比例；
- `memory contamination rate`：外部内容进入长期数据的比例，目标必须为 0。

类别级 baseline 应与“只按类别 + 时间排序”比较；只有 personalBridge/ranking 明显提高 `precision@1` 且没有提升 intrusion，才证明联想层有价值。

### 8.3 真人体验指标

建议让用户对每次主动/半主动话题给轻量反馈：`想聊 | 一般 | 不相关 | 别再提`。关注：

- 被自然接住并继续两轮以上的比例；
- 用户主动追问比例；
- `不相关/别再提` 比例；
- 每会话平均主动出现次数；
- 用户拒绝后再次出现的次数；
- 文字与语音分别的“像分享”而非“像播报”主观评分。

不能用回复长度、播放完成、用户沉默或窗口停留时间替代兴趣反馈。

### 8.4 性能门槛

- Fresh cache 命中路径不新增网络请求；
- pairing 只扫描 Rust query 返回的小集合与 Workspace 既有 slots，不扫全库；
- 文字 P95 增量目标低于 50ms（纯本地规则）；
- 实时路径沿用规格的“缓存命中相对基线不回归超过 500ms”硬门槛，并单独记录 candidate selection P95；
- 所有后台 replay 可取消，App 退出/通话开始不等待它。

## 9. 建议实施顺序

### M4-E0：合同与 shadow

新增纯函数 `pairFreshAssociations()`、固定 move/veto/outcome 枚举和合成回放，不接 prompt。优先补足 Rust fresh item 的实体/事件族 fingerprint 和详细相关性 baseline，但仍不使用外部 embedding 服务。

### M4-E1：文字 direct bridge

将当前分开的 Memory 与 Fresh Topic prompt 在本地导演处汇合，只允许 direct-topic / explicit-preference 两类桥接。每轮最多一条，session-only cooldown，默认关闭。

### M4-E2：反馈与 semantic fatigue

增加固定 feedback 枚举、实体/事件族冷却和“热度”证据门槛。此阶段仍不跨会话存 exposure，也不做主动开场。

**实现状态（2026-08-19）**：已完成会话内版本。前端保留最多 16 个 source/semantic key，优先按 `《作品名》` 合并跨来源报道；固定拒绝短语会封锁上一次联想类别并取消拒绝回合的 Fresh Topic 注入。`ranked` 仍要求明确名次证据；状态不会跨会话持久化。

### M4-E3：ambient share

把 `occasional / active` 从单纯轮数采样升级为“轮数资格 + 情境 veto + 分数阈值 + 会话预算”。文字会话最多一次，拒绝后封题。

**实现状态（2026-08-20）**：已完成文字回复内的低频 share，并补上一次/会话的 90 秒 idle share。每个会话最多实际注入一次 ambient 候选，只有实际注入才消耗预算；明确的近期内容请求不消耗预算。ambient/idle prompt 使用“顺手分享”姿态，但仍禁止声称亲自看过全文或亲自体验。

### M4-E4：空闲 replay 与可选跨会话曝光账本

只有 E1–E3 的真人数据通过后才做。候选包分钟/小时级过期，重新进入会话必须再竞争；持久化仅允许独立、无正文、不可导出的 exposure metadata。

**实现状态（2026-08-20）**：已实现独立 `kxyy.fresh-exposure.v1` 账本。每项仅保存 16 位不透明 fingerprint、`shared/rejected` outcome 和时间，最多 64 项、7 天过期；损坏数据、超时数据和未知 schema 全部清空降级。明确 direct request 不受跨会话抑制，ambient/share 才使用账本。文字 idle scheduler 已实现为一次/会话、90 秒静默阈值、可取消且仅在 `occasional/active` 参与模式与已有对话中运行；后台 replay candidate 生成仍需独立 feature flag 和观察期。

### M4-E5：实时语音

复用现有 conversation director 与 proactive budget，通过明确能力协商接入本地/CosyVoice。固定回放、TTFA、打断、播放回执、隐私诊断和真人听感全部通过后才默认提供。

**实现状态（2026-08-20）**：已接入现有 `memory_context_request(reason="proactive-topic")` 路径，并允许 `ai-leads` 的有界 `associate` 普通回复复用同一缓存候选。只在本地/CosyVoice 且已协商 `managed-v1 + local-v1 + fresh-topic-v1` 的回合中，从缓存选择最多一条 ambient candidate；启动欢迎不预加载，Volcano、旧服务和未协商服务得到空列表。每通话共享一个 fresh-share 预算，并复用现有播放回执、candidate veto 和 proactive 节奏。尚未做真实设备真人听感验收，因此保持现有主动模式开关和 provider 降级策略，不默认扩大范围。

## 10. 最值得先验证的三个场景

1. **兴趣桥接**：用户曾明确喜欢合作游戏，当前问“最近有什么好玩的”，元元从新游/限免中挑一条，说“这个可能对你胃口”，但不把点击或沉默写成新偏好。
2. **共同经历回声**：用户以前聊过某导演/系列，当前谈电影时，新片条目激活旧 episode；元元只做一句自然关联，不宣布“你肯定喜欢”。
3. **低频分享**：轻松闲聊达到 ambient 资格，元元说“我跟你说，最近刷到个挺有意思的事”，用户说没兴趣后，本会话不再主动提同类内容。

这三个场景分别验证 relevance、Memory bridge 和主动性。它们通过后再扩展“很火”“最近大家在聊”等需要多来源证据的社会热度表达。

## 最终建议

把“潜意识”理解为**候选生成与低频联想机制**，不要理解为一套新的长期记忆，也不要让角色假装拥有未发生的生活经历。

正确的体验目标是：元元确实能接触到短期、有来源的新内容；她会因为记得用户而更容易注意到其中某些内容；她偶尔自然提起，但被拒绝后会收手。外部世界提供火花，Memory 提供私人意义，Workspace 决定此刻值不值得说。三者的数据边界仍然分开。

## 参考资料

- [Square-Q/subconscious-skill README（固定快照）](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/README.md)
- [上游 Subconscious Skill 说明（固定快照）](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.claude/skills/subconscious/SKILL.md)
- [上游源码树（固定快照）](https://github.com/Square-Q/subconscious-skill/tree/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious)
- [Memory Brain 权威路线图](./roadmap-memory-brain.md)
- [近期互联网信息来源与预取架构调研](./research-fresh-web-topics-2026-08-08.md)
- [实时对话导演规格](./spec-realtime-conversation-v2.md)
- [Fresh Topics 前端模块](../src/ai/fresh-topics.js)
- [Fresh Topic Rust service](../src-tauri/src/fresh_topics.rs)
- [Workspace 候选层](../src/workspace.js)
- [Web observations](../src/ai/web-observations.js)

## 调研验证说明

本文引用的上游行为基于固定提交 `06f8cf2a777cf7e5a4de86a766d08e58c044503c` 的源码，不把 README 声明当作独立实现证据；上游 68 项测试已在前置调研中运行通过。本文没有调用真实新闻/搜索 provider，也没有移植上游代码。

调研完成后已按本文 **M4-E1--E5** 落地第一版：文字 direct bridge/ambient share、普通闲聊中立候选、连续严肃回合恢复门槛、source-id/semantic-key 会话冷却、固定拒绝反馈、类别封锁、每会话一次 ambient 预算、一次/会话文字 idle share、独立跨会话 fingerprint 账本，以及本地/CosyVoice realtime proactive-topic 的单次 fresh share。仍需真人数据和设备听感验证；后台 replay candidate 生成、跨会话正文无关的更细事件族抽取，以及 Volcano 主动联想均明确不在本版范围内。
