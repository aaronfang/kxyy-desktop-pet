# `subconscious-skill` 接入 Memory Brain 的效果与边界调研

> 调研日期：2026-08-19
> 上游仓库：[Square-Q/subconscious-skill](https://github.com/Square-Q/subconscious-skill)
> 上游快照：[`06f8cf2a777cf7e5a4de86a766d08e58c044503c`](https://github.com/Square-Q/subconscious-skill/tree/06f8cf2a777cf7e5a4de86a766d08e58c044503c)
> 本项目快照：`0980779a472c8a1b9d7492a2b2d59f9fbab6df1b`
> 范围：只评估产品机制、Memory Brain 兼容性和保守接入设计，不改生产代码。

## 结论

`subconscious-skill` 值得借鉴，但**不适合把代码或 Skill 直接装进元元桌宠**。

它最有价值的不是“弗洛伊德/荣格式潜意识”叙事，而是三个可以落到产品上的机制：

1. **重复经历变成模式候选**：不只记得“发生过什么”，还会察觉“这类事情又出现了”。
2. **低打扰的主动联想**：在相关时机轻轻提起一条旧经历、未完约定或跨事件联系，而不是等待用户精确检索。
3. **离线重放与自然遗忘**：空闲时重排关联，降低陈旧噪声的竞争力，让有限的记忆预算更多留给近期、反复出现或用户确认过的内容。

这三点会让元元从“能检索历史的聊天角色”变成“偶尔自己想起共同经历、注意到反复模式、会用旧经验接住当前话题的角色”。最有趣的效果会是关系连续性和恰到好处的意外联想，而不是记忆条数增加。

但是，上游是一个约 4,500 行、单次初始提交形成的 Claude Code 概念原型。它使用手工 session log、JSON 文件、关键词规则和会话首部注入；缺少本项目已有的 scope、证据、冲突、删除一致性、敏感信息过滤、事务恢复和 observation 边界。上游 68 个测试在本次快照上全部通过，但这些测试主要验证原型自身的纯函数和文件 I/O 行为，不能证明它满足桌宠的隐私、数据一致性或长期体验门槛。[上游测试文件](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/test/test_all.py)

建议采用 **clean-room 的“Subconscious Replay”实验层**：复用现有 SQLite 事件、Memory Graph 和默认关闭的 Workspace，只生成短期、带证据、带反证、可过期的 `insight`/`hypothesis` 候选。第一阶段不新增长期记忆类型、不引入 Python 常驻进程、不改人格或 system/skill 规则，也不自动把行为模式写成事实。

## 1. 上游实际做了什么

### 1.1 数据流

上游的完整链路是：

```text
Agent 主动写 session_log.jsonl
  -> SessionEnd hook
  -> 按空行切段，生成 episodic memory
  -> 标签 / 关键词 / 项目匹配，建立 relation
  -> 同标签或图连通分量达到阈值，生成 condensed insight
  -> 对旧记忆减分、对被关联记忆加分、低分归档
  -> 选择最多 3 条 whisper，留到下个 SessionStart 注入
  -> 同一次 SessionEnd 还会执行 dream：跨类型关联、跨会话链接、模式提取
```

这不是读取 Claude Code 完整 transcript。Skill 明确要求 Agent 在回复前后自行调用 `session_logger.log()`，logger 只向 JSONL 追加一段文本、标签和事件类型；SessionEnd 再读取并删除该文件。[Skill 工作流](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.claude/skills/subconscious/SKILL.md#L185-L236) [logger 实现](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/hooks/session_logger.py#L19-L48) [SessionEnd 实现](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/hooks/post_session.py#L20-L71)

五阶段算法全部是本地 Python 规则，不调用模型：编码器按空行或 Markdown 标题切段，并通过固定中文关键词提取“决定”“结果”和少量技术标签；联想器对标签、标题关键词和项目做字符串匹配。[编码器](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/encoder.py#L17-L55) [联想器](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/associator.py#L49-L92)

### 1.2 三种长期记忆与两种派生产物

上游定义：

| 上游对象 | 含义 | 生成方式 |
|---|---|---|
| `EpisodicMemory` | 一次事件、决定、结果 | session log 分段 |
| `SemanticMemory` | 概念、定义、来源情景 | 有数据模型和手动接口，自动管道并不生成 |
| `ProceduralMemory` | 用户习惯、工作流、重复模式 | 固定模板关键词命中达到次数 |
| `MemoryRelation` | causal/similar/contrast/temporal/symbolic 边 | 实际自动路径主要生成 similar、temporal、symbolic |
| `CondensedInsight` | 多条同类记忆的抽象 | 同标签集合或强关联连通分量达到 3 条 |

数据模型见 [schemas.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/schemas.py)。程序记忆不是开放式归纳，而是五个内置模板的关键词匹配，例如“反复调试同一模块”“重复踩坑”“编码风格固化”。[patterns.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/patterns.py#L39-L100)

凝缩也不是语义总结。它按单个共同标签分组，或把强关联图的整个连通分量作为一组；“抽象”只是拼接前几条摘要的前 120 个字符并加固定前缀，“含义”由聚类数量套模板生成。[consolidator.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/consolidator.py#L38-L139)

### 1.3 Whisper、梦境和遗忘

Whisper 在下个会话开始时输出最多 3 条。候选优先级是“最近的凝缩 insight -> 全局重要性最高的活跃记忆 -> 本轮高分新记忆”，并不使用下个会话的用户问题做相关性选择。[候选生成](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/subconscious.py#L179-L232) 注入后包文件会被删除，进程内 `_history` 只负责该对象生命周期内去重。[pre_session.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/hooks/pre_session.py#L16-L30) [whisper.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/whisper.py#L57-L91)

“梦境”包含两类确定性建边和一个随机提示：

- 情景与语义记忆有共同标签时建立 `symbolic` 弱边；
- 不同情景有共同标签且尚未相连时建立 `temporal` 边；
- 随机挑选两种不同类型的记忆并显示标题和共同标签，共同标签可以为空。

对应实现见 [dream.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/dream.py#L41-L79) 和 [随机 dream whisper](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/dream.py#L166-L197)。

遗忘以“每次管道运行”为时钟：不在本轮新建列表中的所有活跃记忆，基础分固定减 `0.05`；被新关系引用的记忆先加 `0.1`，总分低于 `0.1` 后只归档不删除，pin 可阻止衰减。[importance.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/importance.py#L13-L24) [固化循环](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/consolidator.py#L172-L242)

## 2. 加进元元后，哪些效果会真正有趣

### 2.1 “我们总会聊回这里”

元元可以发现三个不同会话都围绕同一主题、人物或情绪，并在第四次自然地说：“最近你几次提到这个，感觉它对你挺重要的。”这比召回某一条事实更像长期相处，因为输出的是**重复性**，不是档案复述。

适合的落点是短期 `insight` 候选：至少三个不同 episode 或不同日期窗口，保留每条 evidence ID；它只允许影响当前回复，不能直接成为新的稳定 fact。

### 2.2 共同经历的“回声”

当前话题与旧经历只有 topic/entity/关系边上的间接联系时，元元可以做一次轻联想，例如用户说工作进展，元元想起之前约定的庆祝方式。好的效果不是暴露“检索到 memory #123”，而是在自然回复里使用一条背景，再把来源留在记忆检查器中。

这类效果可直接复用当前 Workspace 的 1–2 跳图扩散。现有实现已经限制候选总量、槽位数、过期时间、敏感信息和指令型内容，并将候选渲染成不可执行 observation，而不是系统规则。[现有 Workspace 实现](../src/workspace.js) [Memory Brain M4 边界](./roadmap-memory-brain.md#M4Global-Workspace--涌现联想实验)

### 2.3 温和地看见习惯，但不替用户下诊断

重复发生的可观察行为可以变成一句试探：“你是不是更喜欢先自己摸清楚，再让我一起收尾？”用户确认后，它才可进入稳定偏好；用户否认就消失或留下反证。

这比上游直接生成 `ProceduralMemory` 更适合角色产品。程序性知识在当前 Memory Brain 路线图中明确要求人工批准，自动学习也不得修改人格、system prompt、skill、工具权限或安全策略。[目标记忆层次与治理](./roadmap-memory-brain.md#31-目标记忆层次)

### 2.4 有节制的“想起你”

当没有强相关记忆时，系统可以偶尔从近期高价值 episode、pending commitment 或用户置顶项中选择一条，形成一次低频主动关心。它会增强陪伴感，尤其适合桌宠和实时语音；但必须有会话内 source-id cooldown、每次最多一条、拒绝后的长期冷却，并避免在严肃任务中抢话。

这应沿用本项目已有的主动实时对话节奏和 `WorkspaceCandidate` 竞争，而不是复制上游“每次 SessionStart 固定注入三条”的方式。固定开场注入与当前问题无关，容易从惊喜快速变成重复播报。

### 2.5 记忆会“淡”，但不会神秘消失

召回评分随真实时间、近期确认和实际使用自然降低，可以减少过时偏好抢占上下文。用户仍可在设置页查看归档项、恢复或彻底删除；置顶、待兑现约定、用户编辑内容不自动归档。

这种体验比无限累积更像长期关系，但衰减只能改变**竞争力**，不能改写证据、删除事件或绕过现有管理页。

## 3. 与现有 Memory Brain 的重叠和缺口

| 能力 | 上游 | 本项目现状 | 判断 |
|---|---|---|---|
| 情景记忆 | JSON episodic | SQLite episode + 来源片段 +事件 | 已覆盖，现有实现更强 |
| 稳定事实 | semantic 模型，自动管道基本不产出 | fact + predicate/value + confidence + valid time + conflict/supersede | 不应替换 |
| 前瞻记忆 | 无专门类型 | pending/fulfilled/expired commitment | 本项目明显更强 |
| 关系图 | 标签/标题字符串自动边 | topic/entity、来源事件、置信度、derived、幂等边 | 只借鉴候选生成思路 |
| 模式记忆 | 固定关键词 -> procedural | 暂无长期 procedural；Workspace 支持临时 insight/hypothesis | 有产品增量，但必须人工确认 |
| 凝缩 | 同标签/连通分量 -> 固定文本 | LLM 异步巩固 + episode/fact/commitment；有证据和冲突 | 只适合做无模型 replay 基线 |
| 主动联想 | 下次会话开头最多 3 条 | 每轮选择性召回；Workspace 默认关闭；语音有有界主动节奏 | 可增强，但应走 Workspace |
| 遗忘 | 每次运行固定减分、低分归档 | 有有效期、状态、清理、编辑、删除和 scope 清除 | 仅可增加时间型 ranking decay |
| 安全与来源 | 无 scope/consent/evidence/injection sanitizer | append-only event、evidence、scope、敏感过滤、observation 边界 | 必须保留现有治理 |
| 恢复一致性 | 多个 JSON 文件原地写 | WAL、foreign keys、幂等、重放、备份与完整性检查 | 不采用上游存储 |

本项目的基线不是简单 RAG。Memory v3 已有选择性召回、异步巩固、事实纠错与替代、承诺状态、敏感过滤和设置页管理；v3.1 又加入事件溯源、evidence、关系边、重放与统一 observation sanitizer。[当前基线](./roadmap-memory-brain.md#2-当前基线Memory-v3) [M1 内核](./roadmap-memory-brain.md#M1Memory-v31-内核基础Graph-和外部接入的前置)

因此，“编码、联想、凝缩、固化、预注入”五段名称与现有能力高度重叠。真正缺少的是：

1. 从多个**不同事件**中生成“重复模式”候选；
2. 在没有新用户问题时进行受控 replay/incubation；
3. 把低频主动联想作为独立体验策略，而不只是 query-based recall；
4. 对陈旧但未失效记忆使用真实时间型 activation decay。

这些恰好应进入当前 M4 Workspace，而不是另建第二套 Memory 数据库。

## 4. 不能直接接入的原因

### 4.1 数据治理不兼容

上游默认把所有项目的记忆写到 `~/.claude/memory`，索引没有 user/card/project scope 外键，也没有 consent、source event、evidence、敏感等级或按 scope 删除。[storage.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/storage.py#L23-L49) 更严重的是 SessionEnd 把项目名硬编码为 `subconscious`，因此 README 宣称的多项目语境在自动路径中并没有正确保留。[post_session.py](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/hooks/post_session.py#L43-L52)

元元必须继续按 `persona-relationship:<user_id>` 隔离，未来 project/connector scope 也只能通过既定 M5 接入网关扩展，不能从 home 目录共享 JSON 偷渡进来。

### 4.2 派生产物缺少幂等和反证

`save_condensed()` 每次都向索引追加新 UUID；`condense()` 会重新扫描全部活跃聚类，没有 cluster fingerprint 或已处理标记。因此同一组源记忆可以在每轮重复生成新 insight。[condense 实现](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/consolidator.py#L38-L89) [存储实现](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/storage.py#L224-L230)

程序记忆也每次创建新 UUID，没有按模板和来源集合更新旧记录。它只有命中次数和 confidence，没有反证、适用范围、失效条件或用户否认路径。[程序记忆生成](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/consolidator.py#L272-L319)

这会把“联想”逐渐固化成自我强化的偏见。本项目已有 `incubateWorkspaceHypothesis()` 的最低门槛：至少两个 evidence source 和一条 counter-evidence/待验证条件，且 hypothesis 有短期过期时间、永不自动升级为 fact。[现有收纳器](../src/workspace.js#L246)

### 4.3 遗忘时钟错误

上游文档称“未被引用的记忆每次衰减 5%”，代码实际上是每次运行从 base 固定减 `0.05`，而且 SessionEnd 每次都运行一次全局衰减。[README](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/README.md#L212-L218) [apply_decay](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/importance.py#L74-L78)

结果是“聊天次数多”会让旧记忆更快消失，而不是“经过更长时间且持续无用”。对陪伴角色尤其危险：一段密集闲聊可能让重要共同经历迅速失去资格。应使用单调/墙钟时间差计算 recall activation，且归档需要最小年龄、低重要性、低近期使用三个条件共同成立。

### 4.4 “梦境”容易生成无意义或错误联系

上游把共同标签直接解释为 `temporal` 或 `symbolic` 关系；随机 dream whisper 即使共同标签为空也会输出两条标题。这可以制造新鲜感，但没有因果、时间或语义证据，不能写回长期图，更不能被角色当成用户真实经历。

在元元中，梦境只能是 `derived:true`、高 uncertainty 的临时 hypothesis。措辞必须是试探式“我忽然想到……它们会不会有点关系？”，并允许用户一键否认；否认应成为 counter-evidence，降低同类候选再次出现的概率。

### 4.5 配置和声明尚未闭环

Skill 文档公开了 `SUBCONSCIOUS_FORGET_THRESHOLD`、`SUBCONSCIOUS_DECAY_RATE` 和 `SUBCONSCIOUS_CONFIRM_REQUIRED`，但快照代码只实际读取 mode、knowledge dir；归档阈值和衰减率使用模块常量，confirm 变量仅声明而未执行写前确认。[Skill 配置表](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.claude/skills/subconscious/SKILL.md#L173-L181) [whisper 配置](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/core/whisper.py#L22-L24) [importance 常量](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/models/importance.py#L13-L24)

README 还称记忆是 “Markdown + frontmatter”，实际 `Storage` 写的是 JSON。文件通过 `Path.write_text()` 原地改写，没有事务、临时文件 rename、跨进程锁或损坏恢复。[Skill 存储说明](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.claude/skills/subconscious/SKILL.md#L130-L133) [JSON 写入](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious/memory/storage.py#L70-L82)

这些不影响它作为演示的启发性，但说明它还不是可直接承载用户长期关系记忆的组件。

## 5. 保守集成设计

### 5.1 原则

- **概念复用，代码不复用**：MIT 许可允许参考，但现有 Rust/SQLite/JS 基线更完整，不引入第二份 Python runtime 和 home-dir 数据库。[上游 MIT License](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/LICENSE)
- **事件是真相，联想是派生物**：只从有效、当前 scope、非敏感的 materialized memory 和 `memory_events` 生成候选。
- **先短期、后长期**：第一阶段所有产物只存在于当前 Workspace；没有自动创建 fact、episode、commitment、edge 或 procedural memory。
- **可解释也可否认**：每个候选保留 2–8 个 source IDs、生成规则版本、uncertainty、expiresAt 和至少一条反证/待验证条件。
- **不改变权限层**：候选通过现有 observation sanitizer；永远不能修改 persona/system/skill、工具权限、Memory 写策略或安全边界。
- **默认关闭**：复用 `memoryWorkspace` feature flag，另加独立的 idle replay 子开关和观察期，不因打开 Workspace 自动开启后台重放。

### 5.2 推荐数据流

```text
memory_events / facts / episodes / commitments / graph
  -> scoped snapshot（只读，固定上限）
  -> deterministic replay rules
       - repeated-topic candidate
       - repeated-behavior candidate
       - unresolved-thread candidate
       - weak cross-episode hypothesis
       - wall-clock activation decay
  -> evidence + counter-evidence gate
  -> WorkspaceCandidate(kind=insight|hypothesis, derived=true)
  -> 现有竞争、去重、敏感过滤、4--6 slot 上限
  -> 最多 1 条可说出的“联想提示”
  -> 用户确认 / 否认 / 忽略 feedback
  -> 只有确认后，才走现有 memory event 写入和 revision 路径
```

初期不要创建 `memory_insights` 表。候选可以由纯函数从 bounded snapshot 生成，在会话内缓存；这样数据库重建、清除 scope、备份和删除语义都不需要改变。只有离线评测和观察期证明候选稳定、可解释且用户确实愿意管理它们，才讨论持久化派生 insight。

### 5.3 四类候选规则

| 候选 | 最低证据 | 输出限制 | 长期写入 |
|---|---|---|---|
| `repeated-topic` | 3 个不同 episode，跨至少 2 个时间窗口，共享规范化 topic/entity | “最近几次都提到……” | 不写；仅影响当前回复 |
| `repeated-behavior` | 3 个用户行为证据，不能由助手措辞自证 | 必须提问确认，不陈述人格判断 | 用户明确确认后才写 stable fact/preference；procedural 仍需人工批准 |
| `unresolved-thread` | pending commitment 或有明确未完成状态的 episode | 优先级高，但受 snooze/cooldown | 继续使用 commitment 状态机 |
| `cross-episode hypothesis` | 2 个不同来源 + 一条反证/未知条件 | exploratory 模式、每次最多 1 条、短期过期 | 永不自动升级；确认后走现有写入 |

不要用“同一个宽泛标签”直接证明模式。例如三个 episode 都含 `work` 不足以形成“用户工作焦虑”；应要求更具体的 predicate/entity/行为信号，并排除同一会话被拆成多个片段造成的伪重复。

### 5.4 产品呈现

建议设置项仍保持工作型而非心理学诊断式命名：

- `联想记忆（实验）`：关闭 / 保守 / 探索；默认关闭。
- `允许偶尔主动提起旧事`：独立开关；默认关闭。
- 记忆检查器显示“由 3 段经历推测”“尚未确认”“有 1 条反例”，支持确认、不像我、稍后再说。

面向用户的角色表达不显示 `subconscious whisper`、内部 ID 或分数。开发诊断只保留候选数量、规则版本、接受/否认/忽略计数、延迟和来源类型，不导出正文、昵称、topic、Memory 文本或 source IDs；这与现有实时诊断的隐私边界一致。

### 5.5 调度与资源边界

第一版不要常驻“潜意识进程”。推荐触发点：

1. 会话巩固 job 成功后，低优先级生成一个 bounded snapshot；
2. App 已空闲且没有语音通话、TTS、模型拉取、VAD/ASR 安装或 Memory maintenance 时，运行一次纯本地 replay；
3. 每个 card/user scope 最多保留一份临时候选包，新的替换旧的；
4. 有固定扫描上限、耗时预算和取消 token；App 退出不等待；失败不影响聊天；
5. 同一 evidence fingerprint 在固定冷却期内不重复生成。

真实空闲调度仍应遵守路线图现有决策：M4 idle replay 需要独立 feature flag 和观察期，当前主线优先级仍是 M2 设备延迟记录和 M5 接入设计。[下一步唯一入口](./roadmap-memory-brain.md#7-下一步唯一入口)

## 6. 建议实验顺序与验收

### Phase A：离线 shadow evaluator

不改变回复，只对固定合成语料和用户显式选择的本地回放样本运行候选生成器。

验收至少记录：

- 相同 evidence fingerprint 的幂等率 100%；
- 跨 card/user/scope 泄漏为 0；
- private/sensitive/expired/superseded 项进入候选为 0；
- 同一 session 拆段不得冒充三次独立经历；
- 删除任一 source 后，依赖候选不再生成；
- 固定语料的“有用候选率、无关联想率、错误人格归因率”；
- P95 时间、峰值内存、扫描条目上限。

### Phase B：Workspace 内的保守联想

仅文字聊天、默认关闭、每轮最多一个 `insight`，必须与当前问题相关。候选无法通过 evidence/counter-evidence gate 时静默回退普通 recall。先不做无上下文主动开场，也不接实时语音。

### Phase C：用户反馈闭环

增加“确实如此 / 不像我 / 暂时别提”反馈。确认和否认都写成有来源事件；否认不是删除历史，而是反证。只有此阶段稳定后，才讨论可管理的“习惯/模式”视图。

### Phase D：低频 idle replay 和主动提起

在独立 feature flag、固定冷却和文本路径观察期通过后，再评估实时语音。语音必须继续遵守逐轮召回 80--120ms 预算、generation 隔离和失败不阻塞；idle replay 不得在通话热路径运行。

## 7. 最终建议

原始建议是立项为 **Memory Brain M4-E：Subconscious Replay（实验）**，先做离线设计与固定语料评测，不直接实现生产功能。2026-08-20 已在后续专项文档的边界内完成 M4-E1--E5 首版：文字 direct/ambient/idle share、会话与跨会话有界曝光抑制，以及本地/CosyVoice 单次 Fresh Topic 联想；后台 replay candidate 生成、细粒度事件族与 Volcano 主动联想仍未实现。后续评测目标不是证明“AI 有潜意识”，而是回答三个可测问题：

1. 它能否比当前 Top-K recall 更早发现跨会话重复模式？
2. 主动联想能否增加关系连续感，同时把无关打扰控制在可接受水平？
3. 所有推测能否保持来源、反证、scope、删除和回退一致性？

若三项成立，最值得上线的首个效果是：**元元偶尔注意到一件最近反复出现的事，用试探而非断言的方式问你，并在你否认后真的收手。** 这既保留了上游“潜意识”的惊喜感，也不牺牲本项目已经建立的 Memory Brain 治理基线。

## 参考资料

- [Square-Q/subconscious-skill README（固定快照）](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/README.md)
- [上游 Subconscious Skill 说明（固定快照）](https://github.com/Square-Q/subconscious-skill/blob/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.claude/skills/subconscious/SKILL.md)
- [上游完整源码树（固定快照）](https://github.com/Square-Q/subconscious-skill/tree/06f8cf2a777cf7e5a4de86a766d08e58c044503c/.subconscious)
- [本项目 Memory Brain 权威路线图](./roadmap-memory-brain.md)
- [本项目 Workspace 候选层](../src/workspace.js)

## 本地验证记录

在上游固定快照执行：

```bash
cd .subconscious
PYTHONPATH=. python3 -m unittest discover -s test -v
```

结果：`Ran 68 tests in 0.058s`，`OK`。这只证明当前快照的上游测试通过；没有运行其 Claude Code SessionStart/SessionEnd 的真实集成测试，也没有将上游代码接入元元桌宠。
