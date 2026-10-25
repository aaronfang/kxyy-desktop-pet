# Coopanion 调查与元元桌宠改进方案

> 调查日期：2026-10-25。范围：官方仓库文档、源码、测试与本项目当前工作区对照；未安装运行 Coopanion，未测试其模型账号或原生权限。
>
> Coopanion：`0.2.9`，提交 `993cf120938bab760b575aa6002e872642a6ff33`；其锁定的 Cortico 子模块：`cb9ddbd685bcccba1f29905098648f46a79b3862`。本项目：`0.2.52`，HEAD `1591c43bfdd8fc35379aa35eb8f699cd9f4693c2`，并参考现有未提交工作。本文仅增加研究文档，不把工作区中的开发内容视为已发布能力。

## 1. 判断

**第一轮重点是让桌宠的身体、对话和日常行为连起来；第二轮进一步确认，跨平台社交与共同活动也是它的重要价值。** QQ、画室、游戏队友、视频及音乐等详见第 9 节，不能仅按桌面动画产品评价。 元元已有较完整的实时音频、Memory、共同体验及确定性测试；目前更值得补的是：用户摸它，它能在对话中回应；说话时动作能配合内容；等待时知道它在做什么；日常陪伴有稳定的入口、节奏和提醒。

Coopanion 是 Electron 产品，装配 Cortico Core、Cormini Persona、桌宠 World 和模型 Provider；并非可直接嵌入 Tauri 的动画组件。[S1][S2] 建议保持本项目 Tauri/Rust、现有 Memory 和音频协议，按下文逐项独立实现。没有必要为借鉴这些体验先迁移整个 Agent 框架。

## 2. 核实到的能力与差异

| 方向 | Coopanion 的一手证据 | 元元当前基础 | 借鉴判断 |
|---|---|---|---|
| 身体互动进入对话 | `onTouch/flushTouch` 合并戳、摸、抛、放下事件；按配置唤醒或 piggyback，携带次数等元数据。[S3] | `pet-engine.js` 有悬停抚摸、拖拽；`app.js` 已接收聊天情绪并驱动动作 | 高价值：补身体 → 对话的回路，而非再做一套抚摸动画 |
| 对话中编排动作 | `script.ts` 把文本和动作解析成 beats/anchors；动作从当前形象词表解析，未知动作被丢弃。[S4] | 主要是 `thinking/speaking/reply` 和回复情绪映射 | 高价值：从整轮单一动作扩展为少量句段动作 |
| 活动提示 | `StatusTracker` 跟踪运行阶段、工具事件；展示思考、阅读、搜索、等待等状态。[S5] | 有思考/说话动画、共同体验状态及服务准备提示，但跨模式呈现分散 | 高价值：复用真实生命周期，形成一致提示 |
| 引导与设置 | 桌宠气泡逐步引导；普通/高级模式分层。[S6] | README 和设置页提供完整配置，未发现对应的新手引导状态机 | 高价值：降低首次配置成本 |
| 主动性 | Cormini 心跳在无外部活动时逐次退避，上限 8 倍；允许 `end_turn` 不说话结束。[S7] | 已有 Conversation Director、实时主动节奏、Fresh Topics、共同体验主动策略 | 借鉴退避和显式沉默，不新增独立的重复主动循环 |
| 按住说话 | hold/toggle/always 与全局按键；默认语音开关开启后麦克风常开，另有按下才打开选项。[S8] | 普通实时通话已实现；后台陪伴通话有独立规格，仍标记待实现 | 按现有规格补交付，不能照搬常开麦默认行为 |
| 定时提醒 | 持久化闹钟、取消、停机错过后补送、每日本地时刻及 DST 处理。[S9] | Memory 有 commitments；未发现产品级定时提醒调度器 | 高价值：让“约定”成为可执行、可取消的提醒 |
| 记忆 | `PARTNER.md` 每请求整份注入，细节放文件，写操作后 Git 提交。[S10] | SQLite、选择性召回、事件/evidence/revisions、Graph、备份恢复已存在 | 借鉴可读性、变更历史与纠错体验，保留当前内核 |
| 模型与费用 | 多种协议适配、地区端点、能力/quirks；用量页区分已计价、未计价、未知用量。[S11][S12] | DeepSeek/Ollama、本次 token/余额调试、共同体验费用预算 | 借鉴连接诊断、能力声明与完整用量口径 |
| 形象生态 | manifest/api 版本、装扮轴、动作词表、导入预览；代码形象放不透明源 sandbox，禁止网络。[S13] | 固定 roster、帧动画配置、上游素材同步和创建宠物文档 | 中期：先做资源型形象包，再考虑执行代码 |
| 电脑操作 | 独立引擎进程、权限档位、用户操作让行、显示器布局变化拒绝旧坐标。[S14] | 指定窗口观察已有基础；不等于具备桌面操作权限或执行器 | 独立远期产品方向，不混入共同体验 |

几个容易误判的地方：

- Coopanion 的 `web/speech.js` 是按音节播放语音库的拟声系统，类似《动物森友会》；它不是当前元元的自然克隆语音/全双工实时通话的等价验证。[S15]
- Provider README 明确只有 DeepSeek、Anthropic、Step Plan 用真实 Key 测过；配置中存在某供应商不等于其全部能力已实测。[S11]
- CI 覆盖 Windows/macOS/Linux 的构建、类型检查和测试，但不能据此宣称所有原生操作跨平台验收完成；项目自身 macOS 验证文档仍列出了多屏、Space 等复验项。[S16]
- “触摸事件送给模型”有直接源码证据；每次触摸是否最终被可靠保存为长期记忆，本次没有运行验证。

## 3. 优先级总表

P0 是建议首先交付的体验闭环，P1 在其基础上完善陪伴，P2 按实际需求排期，P3 为可选方向。规模为相对判断，不是工期承诺。

| 编号 | 改进方案 | 优先级 | 规模 | 核心收益 |
|---|---|---|---|---|
| 01 | 身体互动进入对话 | P0 | 中 | 用户感觉自己在与元元互动 |
| 02 | 统一活动提示与恢复入口 | P0 | 小～中 | 等待可理解，失败可处理 |
| 03 | 首次引导与基础/高级设置 | P0 | 中 | 更快完成第一次成功交流 |
| 04 | 句段动作与无声回应 | P1 | 中 | 语言、声音与身体协调 |
| 05 | 安静模式与主动行为仲裁 | P1 | 中 | 主动但不打扰 |
| 06 | 按既有规格交付后台陪伴通话 | P1 | 大 | 工作、游戏时偶尔说一句 |
| 07 | 可兑现的提醒与约定 | P1 | 中～大 | 日常陪伴具有连续性和用途 |
| 08 | 可解释的用户画像与记忆变更历史 | P1 | 中 | 用户理解并能纠正它的记忆 |
| 09 | 本地用量账本与预算 | P2 | 中 | 知道费用花在哪，异常可停止 |
| 10 | 模型能力声明与连接自检 | P2 | 中 | 减少配置错误与能力误用 |
| 11 | 资源型形象包与兼容测试 | P2 | 大 | 更容易增添角色、动作和装扮 |
| 12 | 受控的电脑操作助手 | P3 | 很大 | 明确授权下提供桌面帮助 |

## 4. 具体落地方案

### 01：身体互动进入对话

**用户体验**：摸摸元元，它先做本地反应；连续摸几下后，可能轻声回应一句。拖起、放下也可以被它在下一轮自然提及。安静模式只回应动作。

- 借鉴触摸合并和“主动唤醒 / 下轮顺带告知”的区别。[S3] 不要把每次 `mousemove`、`mouseenter` 都当成用户发了一句话。
- 在 `src/pet-engine.js` 暴露真实手势完成事件，经 `src/app.js` 和窄 Tauri 事件桥接入聊天。事件只含白名单类型、次数、会话身份和相对时间；先不记录坐标和轨迹。
- 在桌面专用模块中做合并、限流、去重；为试验先设硬上限，例如合并窗 1 秒、模型回应间隔至少 30 秒、待处理最多 8 条。这些是待听测调整的建议值，不是 Coopanion 参数或已验证最佳值。
- 提供“只做动作 / 偶尔回应 / 更活泼”档位。没有模型时本地动作仍可用；通话、共同体验期间第一版只做本地动作，不抢正在进行的回合。
- 不伪造用户聊天消息，不把触摸推断成“用户喜欢我”等稳定事实；默认只留会话上下文。若以后形成共同经历，必须另走 Memory 来源与同意合同。

**验收**：连续触摸只触发一次合并回应；普通悬停不误报为连续抚摸；拖拽不重复计作点击；中途切人设、隐藏、取消后没有迟到回应；模型离线不影响桌宠交互。

### 02：统一活动提示与恢复入口

**用户体验**：桌宠头顶或现有气泡旁显示“正在想”“正在整理刚才的内容”“正在准备语音”“需要重试”，并在适当阶段提供取消或重试。

- 借鉴状态跟随实际运行阶段的做法。[S5] 第一版映射已有聊天、Memory、共同体验、语音服务事件，不为显示图标新增模型调用。
- 复用 `pet-chat` 桥，在 `src/app.js` 呈现固定枚举。用请求/会话代次拒绝旧完成事件，结束、取消、窗口恢复时重新同步状态。
- 从现有小状态映射开始，不先建设全局 Agent 运行平台。排队、连接、推理、合成、实际播放分别表达，不把“合成完成”显示成“已说完”。
- 状态文字不带记忆内容、窗口标题、文件路径或模型原始错误；用户可见的恢复操作给固定、可执行的说明。

**验收**：取消和断网后无永久“思考中”；旧请求结束不会清除新请求状态；语音加载可以明确显示长时间准备；显示状态不增加网络请求。

### 03：首次引导与基础/高级设置

**用户体验**：第一次启动，元元用几个步骤帮助用户完成“称呼 → 活泼程度 → 文字连接 → 可选语音 → 试聊”；高级参数按需展开。

- 借鉴气泡引导和普通/高级分层。[S6] 第一版可复用现有聊天窗与设置控件，不为向导新增常驻原生窗口。
- 向导采用固定脚本；未配置模型时也能运行，可跳过、关闭、稍后重开。已有配置升级时不强制重新走向导。
- 第一次先保证文字成功；本地语音安装独立进行，明确下载大小、当前阶段和取消结果，不把所有服务串成一个阻塞步骤。
- 首次引导只设置显式偏好；不改默认元元人格，不自动开启屏幕观察、搜索或记忆，不增加来源问卷和遥测。
- 基础页保留常用音量、文字服务、语音、桌宠行为；实验 VAD/ASR、诊断、详细预算等放高级区。已有 Memory 管理和隐私控制保持易找到。

**验收**：无 Key、无 Python、离线均可完成或跳过；中断后可重进；保存配置失败有反馈；秘密不进入向导聊天记录；老用户升级不覆盖配置。

### 04：句段动作与无声回应

**用户体验**：“这个我有点拿不准……”配思考，“不过这点我赞同”配点头；有时只眨眼或坐下，不必每次生成台词。

- 借鉴当前形象能力词表、beats 和动作校验。[S4] 初版只映射元元现有动作，先不把“补全所有表情素材”设为依赖。
- 在桌面侧做一个小的表现计划适配器：一轮最多少量动作、限定时长、未知动作忽略。保留现有 `EMOTION_ACTION` 作为回退。
- 第一阶段可由已有情绪/句段元数据确定动作；以后确需模型输出时，再用独立白名单元数据字段。不要直接向同步的 `persona.js/tts.js` 塞一套不兼容输出格式。
- 动作锚定句段开始或实际播放回执；无词级对齐时不宣称精准口型同步。打断、切角色和 generation 改变立即取消旧动作。
- 动作完成、气泡已显示、音频已播完是不同回执；无声动作不能生成“已听见这句话”的历史记录。

**验收**：无效/超量动作不会卡死播放；取消后不跳出旧动作；动作元数据不被朗读；缺少素材时自然回退；语音内容仍严格由现有播放回执决定入历史。

### 05：安静模式与主动行为仲裁

**用户体验**：“安静半小时”后，元元停止主动开口，可保留低频无声动作；到时恢复。长时间无人回应会主动退场，而不是反复搭话。

- 借鉴 `pet_quiet` 和空拍退避。[S2][S7] 将“保持沉默”作为合法结果，不要求每个候选都生成一句话。
- 在现有各模式发言前增加一个薄的静默/候选准入层：用户输入、当前播放、显式静默、会话取消和预算先判定。触摸、日常主动与到期提醒带来源，不冒充用户输入。
- 第一版仲裁同一模式内的候选；普通通话、后台陪伴、共同体验依然保留各自的权限和时序。不要用一个新全局定时器替换现有三套已定义合同。
- 实时通话的退避继续服从现有播放完成回执与无人回应策略；共同体验继续服从内容新鲜度和对白时机。不能为了“更主动”缩短 endpoint 或启用 neural VAD。
- 睡眠恢复时重新算剩余静默期限，丢弃过期主动候选。明确区分“安静”和“暂停观察/结束通话”。

**验收**：多个来源同时到达不重叠说话；静默时不生成主动模型请求；用户显式提问仍可答；锁屏恢复不补播旧候选；切模式不会继承不应共享的观察权限。

### 06：交付后台陪伴通话

**用户体验**：游戏或工作时按住指定键说话，松开后元元回答；其他时候麦克风停止采集，可以长时间安静挂着。

这项已有完整的 [后台陪伴通话规格](./spec-background-companion-call.md)，应作为既有计划推进，而非另建“Coopanion 模式”。借鉴的是全局按键、就绪反馈及不切焦点的交互。[S8]

- 继续采用现有规格的独立入口、默认物理 `RightAlt`、VoxCPM2 第一版、空闲不采集 PCM、鼠标按住入口和两阶段打断。
- 不能因为 Coopanion 默认打开麦克风就改变本项目边界，也不顺带开启共同体验、前台应用观察或系统音频。
- 本项涉及原生按键、权限、焦点和长时资源，规模显著大于一个 UI 开关；应单独交付。

**验收**：按现有规格验证丢失 keyup、权限拒绝、设备断连、锁屏/睡眠、语音服务恢复、前台游戏焦点和数小时空闲。macOS/Windows 均需真实打包 App 验收。

### 07：把约定变成可靠提醒

**用户体验**：“二十分钟后叫我休息”“每天晚上十点提醒我早点睡”；可查看、修改、取消，应用重开后能说明错过的提醒。

- 借鉴持久化提醒、本地时刻和 missed 状态。[S9] 当前 Memory commitment 只是记住约定，不能宣称等于已经设置定时任务。
- 新增 Rust 管理的有界本地提醒记录与调度；与 commitment 显式关联，但不能把所有约定自动转成提醒。用户明确要求提醒时创建，时间不清楚时再澄清。
- 确定性保存成功才说“已设好”；到期的基础提示无需模型在线，LLM 只做可选人格化表达。限制重试、总任务数和同时到期的合并通知。
- 用任务版本、幂等键和事务状态处理创建、取消、到期、重启；崩溃边界允许显示“投递结果未知”，不轻率承诺分布式意义的严格 exactly-once。
- 一次性相对时间和每日本地时刻采用不同语义；跨天、时区变化、DST、休眠补送、过期太久如何处理，写成可测试合同。
- 显式静默/会议期间默认保留视觉到期提示，语音是否播出由用户设置决定。

**验收**：无效日期和过去时间不误创建；重复请求不重复设定；取消后不响；临近到期重启有可解释结果；模型离线仍提醒；每日任务保持选定的本地时刻。

### 08：可解释画像与记忆变更历史

**用户体验**：用户能看到“元元目前了解的我”、每条依据、何时被更新，并能说“这条记错了”来纠正。

- 借鉴 `PARTNER.md` 的可读画像和写入可追溯性。[S10] 使用当前 SQLite 事实、episode、commitment、来源和 revisions 生成有界管理视图，不新增 Git 依赖或第二套存储真相。
- 优先增加来源跳转、旧值/新值、修订时间及纠错入口。现有 Graph 已展示版本号、支持来源/事件管理及整库恢复，新增价值是单条修订浏览与受控恢复，不是重写已有功能。
- 若需要单条恢复，新增窄 IPC，以新修订表达恢复，并重建对应索引/关系；处理已删除、过期来源、scope 不匹配等情况。删除/清空仍必须清掉相关修订，不让历史成为遗忘漏洞。
- 画像默认是管理页视图。若试验加入聊天上下文，仍受既有召回预算、scope 和数据观察边界约束，不复制整份 `PARTNER.md` 到 system。
- 不允许模型修改人格卡、system/skill 规则或权限。共同体验只按既有最终总结窄接口进入 Memory，不能把原始画面/ASR 转成画像素材。

**验收**：纠错后旧值不继续召回；跨昵称/人设隔离；删除后修订与 FTS 同步消失；备份恢复后的新旧索引一致；Memory 不可用不阻塞聊天。

### 09：本地用量账本与预算

**用户体验**：可以看今天普通聊天、陪看、总结分别花了多少；看到估算依据和未知部分；主动任务超预算后自动暂停。

- 借鉴失败/中断用量、缓存命中、已计价/未计价/未知用量分开统计。[S12] 扩展现有聊天 usage 和共同体验预算，不从零另建计费系统。
- 在 Rust 代理等实际请求拥有者收集固定计数，避免前端重复计数与关闭窗口丢账。只持久化模块枚举、时间桶、token、调用/失败次数和计价版本，不保存请求文本或原始错误。
- 价格带来源、核对日期、币种和版本；本次没有独立核验各供应商现价，不直接采用 Coopanion 表中的数值。缺失 usage 或价格要显示“未知/部分估算”，不能显示为零。
- 先对主动评论和后台总结设置硬准入；达到预算后保留用户主动提问的明确选择。存在在途请求和供应商计费延迟时，要说明本地预算不能保证账单绝不超额。
- 本地模型成本显示调用数/耗时，不假造云端 token 费用，也不把零 API 费用等同于零资源开销。

**验收**：重试/中断计数不重不漏；未知用量保持未知；多窗口并发不能绕过准入；预算耗尽后主动请求停止，已发请求正确结算。

### 10：模型能力声明与连接自检

**用户体验**：配置后能知道“文字可用、图片不可用”“服务已连通但模型不存在”“本地模型尚未加载”，而不是发送消息后才报错。

- 借鉴 provider 与协议/地区/能力分离和显式 quirks。[S11] 首先整理现有 DeepSeek/Ollama，再按真实需求增加一个 OpenAI-compatible 文本入口；不一次接十几家服务。
- Rust 侧声明文字、图片、流式、thinking、usage、工具等能力；请求生成只发当前能力允许的字段。自定义地址不能因为名字像某供应商就被视为完全兼容。
- 自检先区分可本地检查的配置错误与需要发送请求的实际验证；付费请求由用户点击测试触发。正常聊天失败不要静默把私密对话转发给另一家供应商。
- 新增供应商时联动审查 Memory 巩固和实时语音内置 `/api/chat` 调用，避免出现“聊天切了模型，后台仍偷偷走旧服务”。
- 保持普通 WebView 的缓冲响应及内部 SSE secret 边界；不把 Coopanion 的 Responses/工具调用体系直接替换当前同步合同。

**验收**：空 Key、错误地区、模型不存在、无 vision、错误 thinking 字段、半途断流、超时和取消均有固定结果；旧设置幂等迁移；服务商切换不串密钥或推理状态。

### 11：先做资源型形象包，再考虑代码形象

**用户体验**：导入一个形象包，看到作者、版本、预览和可用动作；加载失败自动回到内置元元，旧包升级后仍能运行。

- 借鉴 manifest/api 分离、动作能力词表、装扮状态回退、冻结旧版夹具测试。[S13]
- 第一版只接受图片帧、声明式动作、尺寸/锚点、作者与许可元数据；适配现有 `pet-config.js`、`roster.json` 和 webmeji。PNG 帧宠物无需为了支持鲸鱼形象改造成 SVG 骨架或 Live2D。
- 采用导入暂存 → 校验 → 预览 → 发布到 App 数据目录；限制压缩/解压大小、文件数、像素尺寸和预加载量，拒绝路径逃逸及活动内容，不覆盖内置包。
- 动作能力由实际资源决定；表现计划不能调用缺失动作。升级包缺少当前装扮时回退并提示。
- 有实际代码形象需求后，再评估不透明源 iframe、禁网络 CSP、postMessage 校验及 Tauri capability 隔离；不能因为放进 iframe 就声称已隔离全部宿主权限。

**验收**：旧版固定夹具不改也能跑；缺帧、超大图、损坏包、路径穿越、解压膨胀、导入中断有界失败；卸载正在使用的包自动恢复；鼠标穿透与透明窗口在两端实测。

### 12：受控电脑操作，作为独立远期能力

**用户体验**：用户明确要求后，元元协助打开应用或执行受控步骤；用户接管时停止，随时可取消。

- 借鉴“观察/操作分权”、执行进程隔离、最新截图坐标与多屏布局校验、用户操作让行、可中断回执。[S14] 这些比工具数量更值得学。
- 先从显式应用命令或单步预览开始，不先给任意 shell/全盘文件读写；默认关闭并单独授权，不能沿用共同体验窗口观察同意。
- 执行器先校验目标窗口/显示器代次和权限，再执行；失败后读实际结果。Coopanion 自己的 macOS 记录说明“typed 回执成功”不等于目标控件文本正确。[S16]
- 设每次任务的步数、时间和调用预算；过期截图、用户活动、取消或权限变化时停止。密码、付款、外发内容等需要各自的明确动作边界。
- 与聊天和实时音频解耦排期。当前没有证据支持“增加几个 tool 即可稳定操作电脑”的工期判断。

**验收**：使用受控目标 App 检验实际文字/窗口结果，而非只看工具返回成功；覆盖中文输入法、emoji、快捷键释放、多屏 DPI、Space、取消及引擎崩溃。需独立跨平台原型后才决定产品化。

## 5. 不建议直接照搬

1. **模型自改人格文件**：Coopanion 的 shipped persona 明确允许修改自述文件。[S17] 与元元既有治理不兼容；变化应在用户偏好和有证据的记忆层发生。
2. **整份画像常驻 system**：它方便理解，但每轮付费且扩大上下文污染面。保留当前选择性召回和观察数据边界。
3. **心跳即大模型调用**：只借鉴可沉默和退避，先用确定性准入；没有新事件、没有许可或没有预算时不请求模型。
4. **先造通用扩展平台，再找使用场景**：第二轮确认 QQ、画室和共同游戏很有借鉴价值，上一轮把它们整体后置过于笼统。应先选明确场景实现窄适配器；是否建设扩展市场，等多个适配器暴露共同需求后再决定。详见第 9 节。
5. **照抄音频或 VAD/ASR 链路**：两者目标和合同不同；保留播放回执、单路顺序、取消、有界队列及既有神经 VAD 验证边界。
6. **匿名统计默认开启**：Coopanion 默认 `telemetry: true`，其文档列出了上报字段。[S18] 元元的本地计数与诊断即可支撑本次方案，不引入外部上报。

OBS 透明源、更新后由角色介绍新功能、多语言可以留作附加项：Coopanion 均有对应实现/文档。[S1][S2][S19] 对元元当前目标，优先级低于 01–08。若以后做 OBS，先提供独立的本地渲染视图，显式选择是否含字幕，不能默认把私密聊天复制到直播源；其 Electron 窗口抓帧方式也不能直接移植到 Tauri。

## 6. 建议交付顺序与验证

**第一批：让身体与对话形成回路。** 先做 01 的本地事件/限流和 02 的状态反馈，再交付 03 的最小文字向导。此时不更换模型，不修改 Memory schema。成功标准是新用户能独立完成第一次对话，触摸有反馈，离线和取消均不留下卡住状态。

**第二批：让日常相处稳定。** 做 04/05，并按既有独立规格拆分 06；07 和 08 分别沿 Memory 路线图推进，避免同时迁移存储与音频协议。成功标准是可长期挂着、可以安静、提醒可靠、记错能纠正。

**第三批：扩大可配置性。** 根据真实使用瓶颈选择 09/10/11；12 先做隔离原型。预算统计不能成为第一批互动功能的前置大工程。

每项实施均遵守 [开发测试闭环](./testing-development-loop.md)：先定义用户可见场景和公开测试 seam，逐个 Red → Green；运行窄测试、受影响套件和 `npm run test:gate`。手势、窗口、全局按键、音频、原生权限或资源包变更，另需 macOS/Windows 实机验收。

建议固定一组跨批次场景：连摸不刷屏、输入优先于主动、静默无后台主动请求、播放打断无迟到动作、锁屏不补播、切人设不串上下文、离线仍本地反馈、取消提醒后不触发、纠错后不召回旧事实。行为评价同时听/看真实输出；不能只凭策略枚举变化宣称“更自然”。

本次只完成调查和方案；未运行两项目的功能测试、模型实测或 App E2E，未验证性能/费用提升。文档检查限于内容、引用目标和格式。

## 7. 许可证与实现方式

Coopanion 当前根项目和桌宠包是 **AGPL-3.0-or-later**，有 Steamworks 相关附加许可；Cortico 子模块本身为 MIT；鲸鱼贴图等另有第三方说明。[S20] 本项目 manifest 标记 MIT。

本方案默认只借鉴交互与设计思路，独立实现，不复制其源码或美术。若后续明确要复用代码，应逐文件确认来源及许可，并处理相应分发义务；不能因 Cortico 是 MIT 就把整个 Coopanion 当成 MIT。此项调查不改变当前项目许可，也不扩大为本项目现有话题来源的商业授权审计。

## 8. 一手资料索引

以下链接固定到本次调查提交；每个实现引用都可在克隆源码中复核。

- [S1：README、能力与实测边界](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/README.md)
- [S2：开发文档、架构与发布通知](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/docs/DEVELOPMENT.md)
- [S3：桌宠事件及触摸合并](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/world.ts#L1233-L1276)
- [S4：动作脚本解析与能力词表](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/script.ts)
- [S5：StatusTracker](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/status.ts)、[状态展示字段](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/pet-status.ts)
- [S6：首次引导](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/guide.ts)、[普通/高级模式](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/console/features/mode.ts)
- [S7：Cortico 锁定版本心跳](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/heartbeat.ts)、[Persona/end_turn](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/persona.ts)
- [S8：桌宠包语音输入与按键合同](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/README.md)
- [S9：提醒调度](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/alarms.ts)、[时间边界测试](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/tests/alarms-time.test.ts)
- [S10：画像、记忆文件与 Git 修订](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/persona.ts)
- [S11：模型适配说明与真实账号覆盖](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-provider-coo/README.md)、[Responses quirks](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-provider-coo/src/responses.ts)
- [S12：费用数据模型](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/console/features/cost/types.ts)、[计价版本和来源](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-provider-coo/src/pricing.ts)
- [S13：形象包合同](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/README.md#形象包兼容承诺)、[导入](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/pack-import.ts)、[CSP](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/server.ts)、[冻结夹具验证](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/tests/figure-frame-contract.test.js)
- [S14：CUA 权限、让行、取消与子进程](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/cua/cua.ts)
- [S15：音节拟声播放](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/web/speech.js)
- [S16：CI 矩阵](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/.github/workflows/ci.yml)、[macOS 实测记录与剩余检查](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/docs/MACOS-VALIDATION.md)
- [S17：默认 persona 自述与修改权限](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/seed/persona/coo.zh.md)、[自主配置白名单](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/src/self.ts)
- [S18：装配默认值](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/companion.ts)、[遥测合同](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/docs/TELEMETRY.md)
- [S19：OBS 前端](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/web/overlay.js)
- [S20：Coopanion LICENSE](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/LICENSE)、[Cortico LICENSE](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/LICENSE)、[美术第三方说明](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/packages/cortico-world-desktop-pet/THIRD_PARTY_NOTICES.md)

本项目对照入口：[桌宠事件桥](../src/app.js)、[动画与手势](../src/pet-engine.js)、[Conversation Director](../src/ai/conversation-director.js)、[Memory 实现](../src-tauri/src/memory.rs)、[Memory 权威路线图](./roadmap-memory-brain.md)、[后台陪伴规格](./spec-background-companion-call.md)、[共同体验策略](../src/ai/shared-experience-policy.js)、[共同体验路线图](./roadmap-shared-experience-companion.md)、[AI 同步边界](../scripts/sync-ai.mjs)。


## 9. 第二轮深挖：从桌面宠物到能一起生活、社交和游戏的角色

### 9.1 调查范围与新判断

用户提供的视频为 PalAILab《大肥鱼接万物：关心你、陪你聊天、刷视频、打游戏！桌宠安装与接入教程》，公开元数据为 2026-10-20 发布、13 分 34 秒。[D1] 本次读到公开视频页及元数据；播放器接口未提供字幕或章节，未完成全片观看/转写。因此下文以视频线索继续查仓库，不把源码发现冒充视频逐句内容，也不给未经核实的时间戳。

**更完整的产品定位是：同一个角色，通过不同 World 进入 QQ、浏览器、直播间、画室和游戏。** 它可以接收这些环境的事件，也可以采取行动；其价值不仅是“看着你并点评”，还包括“和你共同完成某件事”。

官方扩展索引本次快照共有 **132 个包：122 个 World、6 个 bot、4 个 provider**。[D2] 这包含社区收录，不等于 132 个 Coopanion 内置功能，也不等于全部通过官方实机测试。本文分三种证据：**源码核实**、**README 中的作者实测声明**、**仅索引契约核实**；本次均未启动扩展、游戏或模型。索引发布版本与源码 HEAD 可能不同，不能混作同一个安装包。

### 9.2 能力地图

| 能力 / 具体玩法 | 实现及核实程度 | 对元元的意义 |
|---|---|---|
| QQ 私聊与群聊 | Cortico 仓内 QQ World，源码核实；OneBot v11 正向 WS，指定群/私聊；文本、图片、引用、合并转发、语音转写、戳一戳等。[D3] | 手机上继续与元元相处，也能把它作为明确身份的群成员 |
| QQ 官方机器人 | 社区 QQ Official World，源码核实；AppID/AppSecret，官方 WS 或签名 Webhook；不是腾讯或 Cortico 官方出品，也不是个人 QQ 账号接管。[D4] | 与 OneBot 是两条路线，应按个人陪伴或群机器人目标选一种 |
| QQ 真语音电话 | 社区 Phone World，源码核实；QQ AVSDK + 外部桥 + ASR/TTS；作者声明 Linux/NapCat 跑通，本机 Windows 未完全验证。[D5] | 可从手机拨给元元，但工程规模远大于文字 QQ |
| B 站视频陪看 | 独立视频 World，源码核实；搜索/选片/播放/暂停/定位，画面拼图 + 时间对齐字幕 + 视频弹幕。[D6] | 补强现有共同体验的媒体语义输入，减少仅靠截图猜测 |
| 一般浏览器助手 | 社区 Browser World，源码核实；CDP 搜索、读页、点击、填表、上传、截图；专属实例或用户浏览器调试口。[D7] | 可以一起逛网页、找资料；完整操作范围需独立于观察权限 |
| B 站直播互动 | Cortico 仓内 World，源码核实；弹幕/礼物/SC/上舰等入站，加本地透明 Overlay；两个工具不向平台发弹幕。[D8] | 直播角色/互动主持模式，有别于个人私密聊天 |
| 一起听网易云 | 社区音乐 World，源码核实；Windows SMTC 或窗口标题读曲目，结合有限热门/最新评论，稳定/节流后接话。[D9] | 音乐是低频、自然的话题入口；读取元数据不能宣称听到了旋律 |
| 共同画画 | 社区 Canvas，源码核实；人类手绘与角色路径笔刷共享画板，编辑、撤销、参考图、保存 PNG、OBS 视图。[D10] | 比“一次性生成图片”更有参与感，可做画头像/添一笔/画回忆 |
| 你画我猜主持 | 同一 Canvas 内有题目、倒计时、揭晓、计分榜，源码核实；聊天消息由另一个连接器送入。[D10] | 单人互动起步后可延伸到 QQ 群/直播；不必先做游戏注入 |
| Minecraft 队友 | Cortico 仓内 Mineflayer 玩家客户端，源码核实；采矿、建造、制作、交易、战斗、蓝图、任务队列。[D11] | 元元拥有自己的游戏角色，能分工合作 |
| 胡闹厨房 2 队友 | 社区 World + BepInEx/Harmony Mod + 虚拟手柄，源码核实；第二位本地厨师，切菜、洗盘、上菜、灭火。[D12] | “一起做事”很强，但需要逐游戏适配与实际关卡验收 |
| 植物大战僵尸操作者 | 社区 Windows x86 原生注入桥，源码核实；读语义局势并调用游戏内输入；严格版本指纹。[D13] | 能实际玩，并非只看屏幕；不适合作为跨平台第一步 |
| 星露谷独立农场工 | 索引声明：SMAPI 桥，自己的体力/背包/位置，可种收、工具操作、箱子、NPC 对话、睡觉。[D14] | 很贴合长期陪伴；仍需核源码和本机 LAN/版本条件 |
| 杀戮尖塔决策 | 索引声明：状态码 + 合法动作编号，出牌、药水、路线、奖励，行动后等待结算。[D15] | 可借鉴为元元自己的回合小游戏合同 |
| 做饭 / 稻田 | 社区 Eat，源码核实；米仓、电饭煲、饱食度、浇水、虫鸟、稻草人、离线补算；双方操作同一世界。[D16] | 最容易形成低成本、可持续的共同活动 |
| 生态箱 / 小花园 | 索引声明：陆地/水体、花草/虫鱼/蚁巢、光湿水质、离线成长、捕食回放、照片海报、邻里论坛。[D17] | 长期养成、照料记录和回忆照片，论坛可后置 |
| 工作陪伴 / 日历 | Pal AI Lab 的 CooCowork，源码核实；Windows 前台/空闲采样、ICS、专注时段、回顾与提醒。[D18] | 从“聊天”扩展到“陪你完成一小时工作” |
| 日程 / 便签 / 休息 | 索引声明：Agenda 有循环/一次性/错过补送与共同便签，另有喝水/久坐扩展。[D19] | 让 Memory 中的约定有实际调度结果 |
| 社区游逛 / 玩梗 / 智能家居 | 仅索引契约核实：B 站 social-media、小黑盒、netlingo 梗库、Home Assistant、ZCode 任务报告。[D20] | 能扩展共同话题与外部行动；不可当成已实测的通用能力 |

### 9.3 QQ：不是一个“接上 QQ”的开关

**路线 A：个人账号协议端 + OneBot。** 仓内 QQ World 作为客户端连 SnowLuma/NapCat 等外部协议端，仅处理启用的群和私聊。普通消息合批，@ 等事件可更及时唤醒；图片可交当前多模态模型或辅助视觉，引用和合并转发可展开，历史可读/搜索。自己的发送事件归档但不再次叫醒角色，避免自我回复循环。[D3]

语音条是另一个消息类型：用协议端 `fetch_ptt_text`，仅当返回“不存在此动作”时回退 `voice_msg_to_text`；不是 World 自带完整 ASR。发送语音可交音频附件，由协议端转换格式。它与 QQ 实时电话也不同。

值得借鉴的是 **起草 → 检查新消息 → 发送或取消**：`qq_draft` 暂存草稿并结束当前工具序列，把期间新到的 QQ 事件交给下一次推理，模型再调 `qq_confirm`。**这里的 confirm 是模型自检，不是默认由人点击批准。** 未确认草稿轮末丢弃；引用不能跨会话。迁移时不能把它描述成已有人类审批功能。

**路线 B：QQ 官方机器人 API。** 社区扩展有二维码绑定、凭证管理、WS/Webhook、消息去重、目标列表、媒体、平台受限的回复流与主动消息；权限和额度仍由 QQ 决定。群、C2C、频道、频道私信的目标 ID 和媒体能力也不相同。源码对发送超时/5xx 等保留“结果未知”，不会一律自动重发，这是值得参考的发送回执语义。[D4]

**元元建议**：先做“主人 QQ 私聊元元”的单目标文字闭环，显式绑定 owner 身份及会话；本人消息与群友消息分开，桌面私密 Memory 不自动对群公开。群聊作为第二阶段，增加 @/提及准入、批处理、频率/费用预算。发给第三方的消息先做可查看草稿和人工确认，再按明确的会话授权开放自动回应。这里是产品设计建议，不是本次研究已获得发送授权。

**QQ 电话应单独排期。** Phone World 依赖另一台登录 QQ 的机器或进程、AVSDK 桥、音频链路与故障恢复，不是安装 npm 包就完成。检查的源码为 0.4.0，索引条目为 0.4.1，不能把二者等同。其接口把“提交拨号”“接通”“合成入队”“桥确认播放”分开；桥确认也不证明远端人听见。元元可以评估复用现有 ASR/LLM/TTS，但必须重新验证电话传输、取消和回执，不能套用本机 Worklet 的完成含义。[D5]

### 9.4 游戏：四个层次，四种工程量

1. **陪看与解说**：从已授权窗口/媒体获得观察，评论、提示和聊天。元元现有共同体验最接近这一层。
2. **自己托管的互动活动**：画室、猜画、回合游戏、厨房/花园。状态和合法动作由 App 控制，最适合先做。
3. **专用游戏桥里的独立队友**：Minecraft、胡闹厨房、星露谷。读结构化局势、调高阶动作，底层负责寻路、按键和核验。
4. **通用截图操作**：视觉识别 + 鼠标/键盘，是另一条路径；前面游戏能玩不证明它可稳定控制任意游戏。

**Minecraft 的关键不是“模型不停点鼠标”**：引擎子进程处理寻路和执行，自保/战斗可抢占普通任务而不等模型。模型决定收集什么、在哪里建、做什么蓝图；回执区分完成、部分完成、受阻、取消。默认完整工具链围绕 1.20.6 / Java 21，服务端与观察客户端自行准备；源码以离线账号连接，目标服务器须允许相应身份。不能泛称所有 Minecraft 版本/服务器即插即用。[D11]

**胡闹厨房 2 真正体现共同活动**：元元可以拿自己的厨师和人分工。“饭好盛出来”“起火灭火”“订单快到期”由有限条件监听触发；Unity 帧级执行器完成移动、转向、手柄动作和结果核对，不等下一轮模型按键。使用者负责菜单，机器人在主菜单加入；需要持续操纵的驾驶终端未支持。当前实现面向 Windows x86 Steam/Unity 构建；作者明确说明直播场景验证过，其他 Persona/非直播兼容待测试。[D12]

**PvZ 的实际代价很高**：源码确有 DLL 注入、进程内钩子及焦点策略代码修改；并非只读内存，也非官方游戏 API。桥只接受特定 GOTY 1.2.0.1073 的 exe/main.pak 指纹，用游戏 UI 线程的输入完成动作，不占用系统鼠标；原生执行器负责自动收阳光、条件触发和点击前重验。Windows x86 工具链、严格构建适配与维护都需要单独预算。[D13]

**画室比想象中更完整**：模型提交命名路径和笔刷参数，可分部件改画、撤销、变换；人可以在同一页面手绘。不是让模型执行任意 JavaScript，也不是只有文生图。猜画模式有题目保密、计时、揭晓和持久榜单，但对猜测的正确性由模型裁决，不应宣称确定性公平裁判。它原实现需要已安装 Chrome 的独立无头渲染进程；元元首版可独立使用现有 WebView 的受限 Canvas/SVG 指令，先不搬这一整套运行时。[D10]

本次索引未发现专用 2048/象棋包；若希望元元玩这些，可以独立设计，但不能列为此次已核实的现成功能。

### 9.5 看视频、听歌与工作：最值得学的是准确的环境事件

**视频**：独立 Bili Video World 观察的是一段时间，不是只看最新一张截图。以抽帧池、画面切换、去重和拼图表示经过的内容，附相应字幕和视频自带弹幕；在模型实际读取时生成观察，减少排队后的旧画面。默认最短 5 秒产生一次观察，频率不代表每 5 秒必须说话。字幕来自登录浏览器的播放器响应，并非每个视频都有；作者对非直播场景仍保留兼容边界。[D6]

**可借鉴到元元**：在现有共同体验会话里增加“视频来源适配器”，输入带媒体 ID、播放时间、seek/暂停代次的短字幕和必要画面，沿用现有授权、预算与回应仲裁。别把整个浏览器历史、评论区或平台登录态当成共同体验的默认输入。Browser World 的通用 CDP 操作是另一层；需要登录/操作时再明确开放。[D7]

**音乐**：网易云扩展只读曲目元数据，参考最多少量评论；连续快切合并、曲目稳定后才触发、冷却期间只更新状态，已经过期的请求丢弃。SMTC 可报告暂停，窗口标题回退无法可靠判断暂停或同名不同录音。元元可先做显式“一起听”会话，让角色偶尔谈歌、聊回忆；不把歌名当成听到旋律、歌词或用户情绪的证据。当前扩展只支持 Windows，macOS 需要独立媒体来源适配。[D9]

**工作**：CooCowork 不仅是久坐提醒。它有 ICS 日历、专注目标与避开的网站、回归欢迎、昨日回顾；每 5 秒读前台程序/标题和空闲时间，不截图，不记按键内容；活动记录默认保留 14 天。[D18] 对元元可以先做不观察屏幕的手动专注计时和日程，再让用户单独选择程序级观察。现有“后台陪伴通话”的不观察约定不能因为添加 cowork 而被悄悄改变。

**持续养成**：Eat 的人类面板和 AI 工具共享确定性状态，只有主人能补米/装水；关机后按时间补算；只有饿到新阶段/煮熟等重要变化推事件，不每个 tick 请求模型。[D16] 生态箱再扩展到照片、成长史、邻里论坛。[D17] 元元更适合先做一盆花/一块田/共同厨房，角色会参与、有结果、有可回顾照片；不必先造完整生态模拟或在线社区，也不把离线损失变成要求用户频繁回来照顾的台词。

### 9.6 元元的第二条改进路线：共同活动

第一轮 01–12 仍是基础体验路线；以下可独立选择一个原型推进，不需要先全部完成，也不建议同时开工。

| 编号 | 建议范围与真实用户场景 | 优先级 / 相对规模 | 首轮验收重点 |
|---|---|---|---|
| A1 | **QQ 主人私聊**：离开电脑后仍能聊，先单目标文字，再图片/语音条和群聊 | 高 / 中～大 | 身份与目标不串、重连去重、取消草稿、发送未知不重复发、私密 Memory 不向群泄露 |
| A2 | **共享画板 + 你画我猜**：你画它猜，它分步画你猜 | 高 / 中 | 可编辑/撤销、答案不提前显示、倒计时恢复、迟到猜测处理、切人设/取消无旧局输出 |
| A3 | **小花园 / 共同厨房**：每天顺路做一件事，几天后一起看成果 | 高 / 中 | 状态持久、离线补算有界且幂等、重复动作不双扣、无模型也可操作、安静不刷屏 |
| A4 | **结构化媒体陪伴**：已有共同体验 + B 站字幕/播放事件，或 Windows 音乐元数据 | 高 / 中；双端来源另估 | seek/切曲撤销旧观察、无字幕降级、仅新鲜输入、回应稀疏、预算不超 |
| A5 | **专注 / 日程 / 便签**：一小时陪写周报、会前提醒、晚间回顾 | 中高 / 中～大 | 漏过只补一次、暂停/取消/睡眠恢复、观察单独启用、明确记录与清除范围 |
| A6 | **受控回合游戏**：先做自有小玩法，再评估杀戮尖塔式桥接 | 中 / 中 | 状态版本 + 合法动作列表，过期/非法动作拒绝，实际结算回执，退出可恢复 |
| A7 | **真实游戏队友原型**：优先选用户常玩的 Minecraft 或星露谷之一 | 需求驱动 / 大 | 单游戏单版本跑通、独立角色、停止/断线/死亡/卡住恢复、本地反应与模型预算 |
| A8 | **直播主持模式**：弹幕问答 + 猜画 + 明确选择的 OBS 画面 | 需求驱动 / 大 | 观众身份、拥挤合批、私聊与直播隔离、公开输出选择、不把本地公告当平台发送 |
| A9 | **QQ 语音电话 / PvZ 注入 / 通用电脑操作** | 后期独立实验 / 很大 | 各自验证传输、平台/版本、执行与取消；不能用文字或截图冒烟替代 |

**建议第一批选 A1 + A2，或 A2 + A3。** 前者解决“随处能联系元元”与“联系后有事情一起做”；后者不依赖 QQ 平台即可快速验证共同活动的吸引力。A4 可接在当前共同体验开发之后。QQ 电话和多款商业游戏不作为这些原型的前置依赖。此处是基于适配范围的排序，没有实测工期或效果承诺。

### 9.7 架构上具体借什么

World 的共同点是 **环境 → 有来源的事件 → 同一个角色判断 → 白名单动作 → 实际结果**。[D21] 可先在元元做三件小事：

- **场景输入适配器**：区分 QQ 发言人/目标、媒体时间线、游戏状态版本与本地养成事件；合批、去重、过期丢弃，输入保持来源属性。外部文本不提升为人格规则或桌面操作授权。
- **动作与回执**：按场景声明允许操作、参数、取消和结果。区分已排队、平台接受、状态改变、实际播放；不把模型说“做了”当作执行成功。采用固定动作调度或模型工具合同视场景决定，无需给所有功能加任意工具循环。
- **共同输出仲裁**：桌面文字、语音、QQ 外发、公开直播分别决定目标和权限；新媒体事件不能抢走正在说话的一轮，群友消息不能调用主人桌面能力。必要的共同经历通过既有 Memory 来源合同另行处理，原始外部观察不直接持久化。

**这不等于可以直接安装 Cortico World。** 官方给出了 L1 工具/生命周期、L2 事件、L3 投递/草稿屏障/消费、L4 实时输出与后台认知等级；QQ 需要 L3，画室需要 L2，Minecraft 完整体验需要 L4。[D21] 仅在元元增加一个 OpenAI-compatible 接口，不能提供这些宿主语义。应先为选中的具体能力独立实现窄适配器；如以后明确要原样复用多个 World，再评估隔离 Node sidecar 和完整宿主兼容，作为单独决策。

扩展包是 Node 运行时代码，不等同于形象包的 iframe sandbox。Cortico MIT、Coopanion AGPL 及各社区包许可分别确认，例如 QQ Official 是 AGPL-3.0-or-later；不要因市场收录就统一视为 MIT。[D4][S20]

## 10. 第二轮一手资料与固定快照

以下资料为源码、作者维护的文档或官方索引。README 的运行效果仅作为作者声明；本次未做账号、模型、电话或真游戏 E2E。未安装 npm 依赖、未发送 QQ/弹幕/平台内容、未运行注入器。

- [D1：视频公开页面](https://www.bilibili.com/video/BV1ZHnF6SEp5/)。元数据由公开 view 接口核实；字幕/章节接口返回空，正文研究不依赖推测视频内容。
- [D2：官方扩展索引，固定提交 b6d5e58](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/catalog.json)。下列标“索引”的能力只代表对应包自述/声明。
- [D3：仓内 QQ README](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/qq/README.md)、[起草/确认及事件处理实现](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/qq/world.ts)。
- [D4：QQ Official 中文说明](https://github.com/leafliber/cortico-world-qq-official/blob/e228d2ec5398b1013d42a0078bbc093f50754f87/README_zh.md)、[World 源码](https://github.com/leafliber/cortico-world-qq-official/blob/e228d2ec5398b1013d42a0078bbc093f50754f87/src/world.ts)，源码包版本 0.2.3。
- [D5：QQ Phone 路线/验证说明](https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/README.md)、[电话和播放状态实现](https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/src/world.ts)，源码 0.4.0，索引 0.4.1。
- [D6：Bili Video 观察设计](https://github.com/Phantivia/cortico-world-bilibili-video/blob/8fca68d2960784ee35aab4b729d1f120478bd849/README.md)、[投递时拼图/字幕/弹幕](https://github.com/Phantivia/cortico-world-bilibili-video/blob/8fca68d2960784ee35aab4b729d1f120478bd849/src/world.ts)，0.2.2。
- [D7：Browser 使用与实测边界](https://github.com/biliye/cortico-world-browser/blob/1c8d1113d9a5084d7221f2001036202b33be7403/README.md)、[工具和生命周期](https://github.com/biliye/cortico-world-browser/blob/1c8d1113d9a5084d7221f2001036202b33be7403/src/world.ts)，0.4.0。
- [D8：B 站直播只读协议/Overlay](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/bilibili/README.md)。
- [D9：一起听网易云的来源/节流/限制](https://github.com/oceanxuhaiao/music/blob/f1b1d7719c9821df35975ce24e702d95210d6dc9/README.md)、[World 实现](https://github.com/oceanxuhaiao/music/blob/f1b1d7719c9821df35975ce24e702d95210d6dc9/src/world.ts)，0.3.7。
- [D10：Canvas 画室与工具](https://github.com/Phantivia/cortico-world-canvas/blob/d5181f9d7e97fc0d7b5d6bc5e2a3704d66bcdfde/README.md)、[猜画主持规则](https://github.com/Phantivia/cortico-world-canvas/blob/d5181f9d7e97fc0d7b5d6bc5e2a3704d66bcdfde/src/GAME_GUIDE.md)、[游戏状态](https://github.com/Phantivia/cortico-world-canvas/blob/d5181f9d7e97fc0d7b5d6bc5e2a3704d66bcdfde/src/game.ts)，0.2.0。
- [D11：Minecraft 玩家/技能/运行环境](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/minecraft/README.md)、[执行器](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/worlds/minecraft/executor.ts)。
- [D12：胡闹厨房 2 安装、行动与限制](https://github.com/Phantivia/cortico-world-overcooked2/blob/1ebeb65a5e19fd7cd296b3a25d869dcacd8a041f/README.md)、[逐帧动作执行器](https://github.com/Phantivia/cortico-world-overcooked2/blob/1ebeb65a5e19fd7cd296b3a25d869dcacd8a041f/plugin/Actor.cs)、[寻路](https://github.com/Phantivia/cortico-world-overcooked2/blob/1ebeb65a5e19fd7cd296b3a25d869dcacd8a041f/plugin/Nav.cs)，0.2.0。
- [D13：PvZ World](https://github.com/Phantivia/cortico-world-pvz/blob/fe4b0ee818e7a7487e7bd5598044d27aa01542e7/README.md)、[原生桥/构建指纹](https://github.com/Phantivia/cortico-world-pvz/blob/fe4b0ee818e7a7487e7bd5598044d27aa01542e7/src/native/README.md)、[注入器](https://github.com/Phantivia/cortico-world-pvz/blob/fe4b0ee818e7a7487e7bd5598044d27aa01542e7/src/native/injector.cpp)、[implant](https://github.com/Phantivia/cortico-world-pvz/blob/fe4b0ee818e7a7487e7bd5598044d27aa01542e7/src/native/implant.cpp)，0.2.0。
- [D14：星露谷索引契约 0.1.4](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-stardew.json)。
- [D15：杀戮尖塔索引契约 0.2.1](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-sts-1.json)。
- [D16：Eat 厨房/稻田](https://github.com/AqualCross/cortico-world-eat/blob/7123a5e30d31c01bbd12b2d6b0c7075abaaca5f8/README.md)、[确定性状态实现](https://github.com/AqualCross/cortico-world-eat/blob/7123a5e30d31c01bbd12b2d6b0c7075abaaca5f8/src/state.js)，0.1.1。
- [D17：生态箱索引契约 0.8.10-bugfix.1](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-terrarium.json)。
- [D18：CooCowork 体验/数据范围](https://github.com/Pal-AI-Lab/cortico-world-coocowork/blob/cdf39f701224590e76cd7112dd4cd30379d81ad6/README.md)、[专注/日历/事件实现](https://github.com/Pal-AI-Lab/cortico-world-coocowork/blob/cdf39f701224590e76cd7112dd4cd30379d81ad6/src/world.ts)，0.1.2。
- [D19：Agenda 索引契约](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-agenda.json)、[休息提醒](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-break.json)。
- [D20：social-media](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-social-media.json)、[heybox](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-heybox.json)、[netlingo](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-netlingo.json)、[Home Assistant](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-homeassistant.json)、[ZCode](https://github.com/Pal-AI-Lab/cortico-extensions/blob/b6d5e5806d54076fb14b096042470140af996859/packages/cortico-world-zcode.json) 的索引契约。
- [D21：World 事件/工具/生命周期](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/docs/worlds.md)、[L1–L4 宿主兼容等级](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/docs/world-compatibility.md)。


## 11. 第三轮深挖：Coopanion 记忆相对元元的优势

### 11.1 结论与比较口径

**Coopanion 的优势集中在模型主动查阅/整理资料、长篇主题笔记、跨 World 持续行动和上下文交接；元元在结构化来源、冲突纠错、隔离、删除与有限预算的工程机制上更明确。** 这不是“文件一定胜过 SQLite”，也没有证据证明 Coopanion 记忆准确率、语义召回率或费用整体更好。

本轮仍固定 Coopanion `993cf12` 与它锁定的 Cortico `cb9ddbd`，比较元元 HEAD `1591c43` 及当前工作区。当前 `memory.rs` 的未提交改动是共同体验降级总结的替换更新修补，不把它视为已发布能力。以下是源码与已有测试的静态核实，未运行真实记忆对话、跨平台 E2E 或定量评测。[M1][M2][M3]

尤其需要划清产品边界：Coopanion 实际在 `core/companion.ts` 装配 **Cormini 的派生 Persona**，不是把 Cortico 仓库里所有 bot 的记忆能力都装进去。仓库另有 `corti-soulmate/subconscious` 等实现，不能据此宣称默认 Coo 已有“潜意识做梦”“后台语义反思”或同等级的自动巩固。[M1][M12]

### 11.2 两边实际数据路径

**Coopanion：**

```text
QQ / 桌面 / 游戏等 World 事件 → 同一个主会话
  → system 常驻已组装的 PARTNER.md + 文件目录
  → 模型可 list/glob/grep → read → 继续查询 → 回应/行动
  → 模型可当场 write/edit/append/move/delete 主题文件
  → 成功的写工具调用在 Git 可用时提交版本
  → 上下文压力预告 → 留笔记 → 确定性生成 handoff 文件 → 新上下文
```

`PARTNER.md` 是简短用户画像；细节放 `partner/`，时序内容可放按月命名日志，旧文移入 `archive/`。这些整理规则主要是提示约定，不能当成存储层强制保证。前缀目录折叠 `archive/`、`handoffs/`、`blobs/` 等大目录，模型仍能用工具打开。[M1][M4]

注意一个源码细节：画像“每请求都带着”是因为它装进 session 的 system 前缀，并非每次请求前无条件重读磁盘。Core 在创建、交接或显式重载等路径重建前缀；文件修改持久化、工具结果可见与现有前缀刷新是不同事情。不能承诺改文件后下一请求所有前缀段立刻同步。[M4][M11]

**元元：**

```text
普通文字 → 回复前一次本地 recall（最后用户文字 + 图片 caption）
  → 近期候选 + FTS → 词法/新近性等排序 → 最多 6 项、500 字
  → 可选 Workspace/图扩散 → 带边界的记忆 observation → 回复

允许记忆的会话批次 → 持久化 job → 后台模型抽取
  → fact / episode / commitment + 来源 + events/evidence/revisions
  → SQLite / FTS / topic/entity/关系边 → 管理、纠错、删除、重建
```

普通文字主要在收起/退出/切身份等路径入队巩固；语音 final 用户文本与可听回复完成有逐轮入队。当前模型没有可以在同一回答中反复调用的公开 `memory_search/read/write` 工具循环。文字还有最近对话和滚动摘要，并非只靠这 500 字；本地语音另有更严格的逐轮召回预算。[M2][M3][M8]

### 11.3 逐项对比：哪些优势成立

| 维度 | Coopanion 实际机制 | 元元当前机制 | 相对结论 |
|---|---|---|---|
| 主动查记忆 | 模型可查文件名、正则搜索、分段读正文，再改关键词继续查 | 一次预召回，query 取最后用户文字/caption；可选图扩散由程序执行 | **明确的能力优势**：能在回答前主动追查，而非只能接受首次候选 |
| 长篇经历/项目笔记 | 任意主题文件、时间日志、归档；按需分段读取 | fact/episode/commitment 结构化抽取；episode 正文最多 1000 字，召回总预算 500 字 | **明确的表达与取用优势**：便于保存条件、过程和项目阶段；不保证模型一定保存 |
| 稳定的整体画像 | 短 `PARTNER.md` 常驻前缀，细节分文件 | 有手填/打包画像、置顶记忆及选择性召回，但没有对应的自动维护整体画像文件层 | **有条件的体验优势**：关键背景不依赖每次命中检索；有常驻成本、陈旧和污染代价 |
| 当场记住/更新计划 | 当前主模型能直接调用写工具；成功返回后已落盘 | 普通文字需到批次入队并经后台巩固；短期历史可立即承接 | **写入时机优势**：适合“现在记下”和边做边改；并非一定写、也非一定正确 |
| 中断后接续行动 | 压力预警；handoff 保存事件、工具参数与回执，区分最近/较早内容 | 普通聊天滚动摘要；本地语音有播放派生历史；未见通用跨工具任务交接档案 | **行动连续性优势**：更适合复杂多步任务与未完成项目 |
| 多场景同一份记忆 | 多 World 同一 Persona/工作区，角色可把 QQ/游戏经历组织到笔记 | 文字/本地语音共用 Memory，但尚无成熟外部 connector 消费层 | **集成优势**：记忆已进入 QQ/游戏等活动，不是存储算法天然更先进 |
| 二进制纪念物 | `save_blob` 把已见附件从日志存储转成持久 `mem:`；后续工具可复用 | 当前长期记忆以文本为主；通用多模态 artifact 在路线图 | **能力优势**：适合明确保存的画作、照片等；不等于有语义图像检索 |
| 人类可读/外部编辑 | Markdown/普通文件，编辑器可直接看；WebUI 有文件树和差异 | 列表、Graph、事件时间线、JSON 导出、备份和恢复 | **可移植性/编辑体验优势**，不是元元缺少可检查性 |
| 修订与追溯 | 成功写工具按次 Git commit，人类修改有 operator 署名，历史可看 diff/旧全文 | item revisions + events/evidence + 来源、重放和备份 | 两种粒度：前者长文差异直观；后者事实来源/状态更结构化，不能单称“它有历史我们没有” |
| 语义检索 | 文件名/glob/正则 + 模型读取后的理解；未见默认 Coo 向量检索路径 | FTS trigram + 字符相似度 + 可选图扩散，无 embedding | **未证明领先**；主动改写查询可能补召回，仍依赖可发现的文件和模型策略 |
| 自动巩固/可靠入队 | 默认 Coo 主要由主模型决定写什么、何时整理 | 持久化 job、幂等入队、worker 恢复/退避与抽取合同 | 元元的后台流水线更明确；不能用“会写文件”替代最终入队保证 |
| 纠错/隔离/遗忘 | 合并、删旧信息等以提示和文件操作为主；工作区/Git 与渠道不是同一隔离层 | card/nickname、来源角色验证、disputed/supersedes、敏感过滤、级联删除等 | 元元机制更明确；跨 connector 的完整 scope 元元也仍需后续建设 |

依据：[M1]–[M11]。表中的“明确”指代码提供该能力，不代表真人实际回忆质量已经比较获胜。

### 11.4 最值得借鉴的六个优势，以及各自的实际含义

**1. 它可以自己去找证据。**

例如用户问“上次我们看那部片时，到底为什么争论结局？”元元的首次 query 很可能缺少片名，依赖字符重合、近期候选与有限承接兜底；如果首次召回没找对，当前对话模型没有第二次检索入口。Coopanion 可以先看目录，搜作品名/结局/观影日志，打开时间段，再决定回答。优势来自可迭代取证；没有记录的细节，两边都不能凭空恢复。[M2][M3][M5]

元元实际召回还要说明精确：近期候选包括事实 50、经历 30、未完成约定 20，再合并最多 50 个 FTS 命中；最终主要由二元字符 Jaccard 60% + 新近性 12% + 重要度 12% + 置信度 8% + 置顶/约定 8% 排序，并非直接使用 BM25 排序，也不是 embedding 语义召回。普通相关性过低的候选会被过滤。[M3]

**2. 它能保留一件事的形状。**

“我们一起设计小游戏”可能包含选择 A 的原因、放弃 B 的理由、还没解决的问题、当前素材和下一步。Coopanion 可以把这些放进一份主题文档，按标题/时间继续维护；不必全部归纳成几条用户事实。元元的结构化层适合稳定偏好和约定，但短 episode/注入预算不适合独自承载完整项目档案。原始 job 7 天、来源片段 90 天的保留策略也意味着，长期摘要之外的原话不是永远可查。[M1][M3]

这不说明 Coopanion 保存了所有历史：模型没写、handoff 预算省略、附件没保存，都可能丢失。其按月日志、按主题归档是合理约定，并非后台自动执行与逐条验证的策略。

**3. 它有较明确的“我与你的整体关系背景”。**

如果用户的重要背景已经被正确压缩进 PARTNER，模型不必每次由“今晚有点累”这句文本去命中工作习惯等事实。元元当前有画像和置顶机制，不能说没有用户背景；差别是 Coopanion 给出了专门、可持续编辑的短画像及详细档案分层。[M1][M2]

但 PARTNER 直接位于系统前缀，正确性、长度和更新依赖整理；代码中“保持简短”是提示，不是严格字符上限。因此元元应借其“整体画像视图”，保留记忆为不可执行 observation 的边界，不照搬整份文件成为系统规则。

**4. 它把“想记住”变成当场可执行动作。**

Coo 在当前回合就可写“这个项目下一步先改画板，不动语音”，拿到写入回执后继续行动。元元普通文字目前主要等待批次入队/后台提取，适合自动省心记忆，但不等于当场已经进入长期存储；同一会话内记得仍可能只是最近历史。语音则已有逐轮入队，不能把文字边界泛化成所有模式都延迟写。[M2][M5][M8]

反过来，Coo 的工具可用不保证模型每次主动调用。元元不应撤掉可靠后台队列；可增加明确、可查结果的记忆提案入口，和原流水线去重。

**5. 它更会把做事现场交给下一段上下文。**

handoff 不只是“用户喜欢什么”的摘要：压力接近阈值先提醒模型保存很早以前仍在跟进的事；清空时确定性保留事件、工具调用参数/回执，并把早期与最近片段分开，状态快照只留最新，重复项合并。最近的发言工具参数和实际回执一起留下，提示“打算说”与“对方看见”要分开。[M4][M6]

它仍是有损交接：不收 assistant 正文/思维链，不递归重塞旧交接，长回执按年龄裁剪；并不是额外模型做了完整语义总结。元元现有滚动摘要与语音播放派生历史各有价值，这个优势主要面向未来多步行动、QQ 和共同项目，不表示应替换目前音频的 audible-completion 合同。

**6. 记忆可以带着具体作品回来。**

`save_blob` 把见过的日志附件复制到工作区，返回 `mem:` 句柄；模型可在笔记里引用，后续 `read_file` 或其他 World 工具可重新展示/使用。对元元，这可以是用户明确保存的一张共同画作、截图或照片，而不只是“我们画过一只猫”的一句文本。[M7]

图片不在 Coopanion 的 Git 跟踪里，旧图版本也不自动由 Git 保证；没有通用向量索引。这层优势是长期 artifact 的保存/引用能力，不能夸大为多模态回忆已经可靠。元元路线图已规划 content-addressed artifact；实现时应走该路线，并保留每种来源的保存同意和撤销边界，不能直接持久化外部观察流。[M9]

### 11.5 不应误认成它的优势

- **“它有 128K 记忆，我们只有 500 字”**：128K 是默认上下文阶段预算，500 字是元元单次长期召回注入预算；元元还有近期聊天/摘要，Coo 也并非把全部文件都放进 128K。两者口径不同，不能直接比大小。[M1][M2]
- **“它有真正语义记忆，我们只有关键词”**：两边默认路径都未证明有 embedding；文件工作区的优势是模型能继续查，不是 regex 本身理解语义。
- **“它有 Git，所以记忆更可信”**：Git 能证明改动发生、方便找回旧文，不能证明内容真实。元元已有来源 message ID、用户/助手角色验证、冲突状态和修订证据；这些也不等于自动验证文本蕴含，仍需事实质量评测。
- **“它有历史和备份，我们没有”**：元元已有 revisions、事件时间线、Graph、JSON 导出、备份验证/恢复和重放工具。[M10]
- **“它可以忘得更彻底”**：文件删除与 Git 历史清除不同。Cormini 的 workspace 清理遍历跳过 `.git`，保留 CONSTITUTION，不能把这一路径描述成历史彻底擦除；元元的单项删除有 events/revisions/FTS/edge 级联，但备份等副本也应另算。[M4][M10]
- **“它会自动做梦整理一切”**：仓库中其他 Persona 的 subconscious 代码不代表默认 Coopanion 已启用。当前 Coo 的主模型自整理和 handoff 才是本次核实到的路径。[M1][M12]
- **“允许自改人格等于关系更真实”**：Coo 可编辑 CONSTITUTION；这与元元默认人设治理不兼容，不列为元元应复制的优势。
- **“跨 World 共享一定更安全”**：同一工作区便于延续，也可能把私人记忆带到群聊/公开输出。共享连续性和读取/外发权限应分开设计。元元当前 card/nickname 隔离不等于已完成 project/connector 多级 scope。[M9]

### 11.6 元元的改进建议：补使用方式，保留可靠内核

| 顺序 | 最小改进 | 保留的当前机制 | 关键验收 |
|---|---|---|---|
| 1 | **文字按需二次查忆**：对显式回忆/细节问题，让模型在首次召回后提出有界查询，再读指定来源片段 | SQLite、scope、敏感过滤、来源、预算、默认单次召回 | 换说法/省略实体能补查；无记录不编；跨人设/昵称零越界；调用/时长有上限 |
| 2 | **明确记住的及时回执**：用户明确要求记住或保存共同计划时，形成持久提案/任务 ID，显示待整理/已保存/失败 | durable job、幂等/重试、事实验证和纠错替代 | “说记住”不能冒充落盘；重试不重复；取消/删除后后台不复活旧内容 |
| 3 | **有来源的整体画像视图**：由用户确认的稳定事实生成短摘要，可展开每句的来源和修订 | 原始事实仍为权威、可纠错；摘要为派生数据，不写人格规则 | 纠错/删除后失效重建；无证据不补关系判断；成本有界 |
| 4 | **共同主题档案**：一件活动/项目一份可编辑结构，包含经过、决定、未决问题、下一步和来源 | facts/episodes/commitments、既有 Memory schema 与 scope 路线 | 不把项目判断永久升级成用户事实；手改与后台合并有冲突处理；可归档/删除 |
| 5 | **活动交接卡**：将已确认行动、实际结果、待办与未完成操作分开；与长期事实分层 | 最近对话/滚动摘要、既有语音实际播放回执 | 取消/中断后不重复已完成动作；未知结果保持未知；重启/切场景正确恢复 |
| 6 | **显式纪念物保存**：用户选择的画作/照片附来源、内容寻址句柄与撤销策略 | M6 artifact 路线、来源授权边界 | 缺文件明确报错；删除引用/原件/备份语义清楚；不默认存媒体观察流 |

第一步无需先上 embedding，也无需把整个数据库改成 Markdown。可以先用固定、只读、受 scope 约束的检索/读取接口验证主动查忆是否真能补齐问题；原型建议最多两次补查、设置总字符和时间预算，这些是建议值，未验证为最优。写工具单独评估，避免因增加读能力就同时开放任意写文件。

语音继续保留 80ms 逐轮召回与现有取消/播放合同；不把慢速多轮工具查询塞进实时主音频路径。project/connector scope、外部 API、语义召回与 artifact 都按 [Memory 权威路线图](./roadmap-memory-brain.md) 追加决策，不能从本次研究直接视为已获实施或跨渠道授权。

验证应比较同一固定题集上的：跨表达召回、较久以前的具体细节、人物/作品消歧、纠错后旧信息使用、无记录时的不确定回答、任务中断续接、写入持久性、费用与延迟。现有来源/隔离/删除用例必须保持；在这组实验完成前，只能说“能力形态有优势”，不能宣布“记忆效果已经更好”。

## 12. 记忆专项一手证据

Coopanion/Cortico 链接固定到上述提交；元元链接为本次工作区可核读入口。本文没有运行外部依赖、模型账号或记忆功能测试，未修改产品代码。

- [M1：Coo Persona、画像、归档与写后提交](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/persona.ts)、[实际装配 Cormini 与默认预算](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/core/companion.ts#L477)、[已有 Persona 测试](https://github.com/Pal-AI-Lab/Coopanion/blob/993cf120938bab760b575aa6002e872642a6ff33/tests/persona.test.ts)。
- [M2：元元普通文字召回入口](../src/chat.js#L1944)、[入队逻辑](../src/chat.js#L1849)、[滚动摘要](../src/chat.js#L800)。
- [M3：元元召回与排名](../src-tauri/src/memory.rs#L3320)、[保留策略/预算常量](../src-tauri/src/memory.rs#L18)、[巩固应用](../src-tauri/src/memory.rs#L4930)。
- [M4：Cormini 前缀/目录、清除、压力和交接](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/persona.ts)。
- [M5：模型可用的完整文件工具](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/workspaceTools.ts)、[文件/检索/附件存储](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/memory.ts)。
- [M6：确定性交接笔记的收录、折叠与排除规则](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/handoffNote.ts)。
- [M7：save_blob](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/blobs.ts)、[Git 存储](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/workspaceGit.ts)、[WebUI 历史/编辑冲突](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/persona/webUiSurface.ts)、[历史版本恢复为编辑草稿](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/cormini/webui/workspace.ts#L738)。
- [M8：元元语音召回预算](../src/realtime-memory.js#L9)、[语音 final 写入](../src/chat.js#L3070)、[可听回复入队](../src/chat.js#L3410)。
- [M9：元元当前边界](./roadmap-memory-brain.md#L53)、[外部接入路线](./roadmap-memory-brain.md#L245)、[语义/多模态后续阶段](./roadmap-memory-brain.md#L271)。
- [M10：元元事实来源验证](../src-tauri/src/memory.rs#L5044)、[纠错/冲突](../src-tauri/src/memory.rs#L5340)、[用户修订](../src-tauri/src/memory.rs#L3893)、[单项级联删除](../src-tauri/src/memory.rs#L4173)、[导出](../src-tauri/src/memory.rs#L1546)、[管理/备份/重建 UI](../src/settings.js#L2334)。
- [M11：Core 前缀创建与重载](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/core/loop.ts)、[WebUI 显式重载入口](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/src/bot.ts#L1060)。
- [M12：不同 bot 的 subconscious 实现，不能归入默认 Coo](https://github.com/Pal-AI-Lab/Cortico/blob/cb9ddbd685bcccba1f29905098648f46a79b3862/bots/corti-soulmate/persona/subconscious/index.ts)。
