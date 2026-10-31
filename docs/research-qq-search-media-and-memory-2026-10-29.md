# QQ 搜索、多媒体与记忆粒度调研（2026-10-29）

范围：回答当前版本的行为、验证上游能力并提出后续方案。本文记录调研时的基线，不代表后续实现状态；本轮实施与最终验收见[实施计划](plan-qq-search-media-memory-2026-10-29.md)。代码基线为 `2874278`（App 0.2.56）；以下“已支持”严格区分底层协议、模型 API 和桌宠／QQ 的完整接入。

## 1. 一轮对话同时产生事实和经历，是否正常

**允许同时产生，但不应每轮固定生成一条事实和一条经历。** 这是语义记忆与情景记忆的不同用途，不等于把两条都当成独立证据。

例如以下为虚构示例：用户说“我更喜欢乌龙茶”，角色回应并聊了原因。

| 类型 | 合理内容 | 作用 |
|---|---|---|
| 事实 | 用户偏好乌龙茶 | 回答“我喜欢什么茶”，支持后续纠错、更新 |
| 经历 | 这次聊了喝茶偏好及原因 | 回答“上次我们聊了什么”，保留时间和对话背景 |

只有“你好／在吗”或没有新增信息时，不应硬生成事实；如果经历只是把相同偏好换句话复述，也没有必要每次新增。

### 当前实现证据

- [`memory.rs`](../src-tauri/src/memory.rs) 的 `Extraction` 独立包含 `episode`、`facts`、`commitments`。`process_job` 明确要求“所有字段允许为空，不要硬凑”，并禁止将角色推测、网页资料、普通寒暄等提取为用户事实。
- `apply_extraction` 对非空、非敏感的经历摘要新建 episode；对有有效用户消息来源的 facts 分别入库。事实通过 `source_episode_id` 关联经历。因此一次整理可以是零项、只有事实、只有经历或多种都有，并非写死 1+1。
- `insert_fact` 对当前用户相同 `predicate + value` 的有效事实更新确认次数和置信度；这是结构键匹配，不代表已实现全面语义去重。
- `recall_memory` 已有文本相似度去重（字符 gram Jaccard ≥ 0.78），不能说当前完全没有去重；但相同来源的事实与经历如果措辞不同，仍可能同时占用召回预算。
- QQ 普通消息发送成功后，`qq.rs::record_evidence` 将这一问一答作为单独的 `qq:{nonce}` 整理任务。电话的 `qq_phone.rs::enqueue_spoken` 按实际完成播放的每个 segment 入队，同一用户回合可能在多个片段任务中重复出现。
- 明确保存走独立回执路径；`explicit_attempt` 会阻止同一明确保存消息再进入普通自动整理，不应把明确保存回执再次视作共同经历证据。
- 这些行为符合[记忆体路线中的语义／情景记忆分层](./roadmap-memory-brain.md)，但目前 episode 的保留价值主要依赖模型输出，尚无“同一来源不得同时有 fact 和 episode”的限制。

### 建议

1. 保留两层结构和来源关系，避免直接删除所有“对应事实的经历”。管理界面可按来源折叠展示，让事实成为该经历的可展开提炼结果。
2. 加强经历准入：纯事实复述、寒暄和保存回执不新增经历；真正的事件、情绪变化、共同活动和有价值的背景才保留。
3. 电话继续逐片段确认“确实播放”，但将证据聚合成同一用户回合的整理任务；保留已听到的片段，被打断／未播放内容不混入。不要通过等到整通电话结束才写入来换取表面去重。
4. QQ 普通消息可在短对话窗口内聚合整理，并保留逐消息来源和幂等键。明确保存仍即时确认，不等待批处理。
5. 召回增加来源感知：事实已足够回答时，避免再注入纯复述的同源经历；询问时间、原因、共同活动时允许补充经历。

验收重点：寒暄不增加无价值条目；重复偏好不增加重复事实；偏好变化保留纠错链；电话多句回复不把同一用户陈述当成多次独立确认；删除、清空、昵称／人格切换和重启恢复保持现有语义。

## 2. DeepSeek 联网搜索：官方支持且真实接口已测通

### 用户提供的中文官方指南核对与后续实现

2026-10-29再次核对[中文 Search／Fetch 指南](https://api-docs.deepseek.com/zh-cn/guides/search)：独立Search为`POST https://api.deepseek.com/v1/tools/search`，Bearer使用同一DeepSeek Key；`query`为1～128 Unicode字符、`count`为1～50、`need_content`默认false。本项目DeepSeek适配器正是这一接口，限定`count:4, need_content:false`，读取`summary`／`snippet`，不接Fetch正文。当前用户本机选择仍是Tavily；添加DeepSeek支持不会静默更换服务商。中文指南当前标价为每1000次成功有结果请求5元；下文美元数额保留为先前英文页面的调研记录，不应混同币种。

是否调用搜索由应用负责：此独立接口不会仅因聊天提示出现“需要新知识”就自行启动。与Pro的Responses内置`web_search`路线不同，项目保留Chat Completions及现有模型、人格、记忆合同，在QQ管线增加独立、短时语义决策。当前文字模型只看本轮问题和北京时间日期，决定是否需要核验外部资料，并输出最多128字搜索词。每轮最多一次检索，不携带Memory、人格、主人昵称或聊天历史到搜索服务；明确“不联网”、私人回忆及明确保存绕过决策。实机与门禁记录见[实施计划](plan-qq-search-media-memory-2026-10-29.md#qq-语义自动搜索与官方接口核对2026-10-29)。此项覆盖QQ文字及语音转写，不宣称QQ电话或整个应用都已改成同一语义策略。

不能继续沿用“DeepSeek API 没有联网搜索”的旧结论。2026-10-29 的官方文档明确提供两种路线。

| 路线 | 当前官方能力 | 对本项目的意义 |
|---|---|---|
| 独立 Search／Fetch | 同一 DeepSeek Key 调用 `POST /v1/tools/search` 和 `POST /v1/tools/fetch` | 与聊天模型分离；Flash、本地模型等都可消费结果 |
| Responses 原生工具 | `deepseek-v4-pro` 支持 `tools:[{"type":"web_search"}]`，服务端执行搜索后继续回答 | 可选进阶路线，但需新增 Responses 适配与边界处理 |
| Flash + Responses `web_search` | 官方明确写为忽略 | HTTP 200 不能证明已经搜索 |
| 现有 Chat Completions | 当前工具字段支持 function；当前 QQ 请求没有工具执行循环 | 仅在提示词中要求联网不会自动接通搜索 |

### 实测结果

使用已有本机配置的 DeepSeek Key；只发送公开文档查询与合成图片，不发送 QQ 内容、人格、历史或记忆。没有向真实 QQ 会话发测试消息，也没有写入记忆库。

| 探针 | 结果 | 本次耗时与证据 |
|---|---|---|
| Search：`DeepSeek Search Fetch API site:api-docs.deepseek.com`，`count=3`、`need_content=false` | HTTP 200，3 条结构化结果，有 `summary`，`content` 均为空 | 约 350ms；含官方搜索指南链接 |
| Fetch：官方 Search 指南 URL | HTTP 200，有标题和 9406 字符正文 | 约 161ms |
| Pro Responses + `web_search`，查询官方 Search 请求路径 | HTTP 200，response completed | 约 2642ms；返回 `web_search_call(status=completed, action.type=search)`，usage 中 `tool_search=1` |
| Flash 图片输入：192×96 左红右蓝合成 PNG | HTTP 200，正确输出左红右蓝 | 约 5936ms，245 tokens；只证明该次基础图像能力 |

这些时间均为单次样本，不能当作 P50/P95、准确率或生产延迟保证。Pro 本次回答的结构化 citation annotations 数量为 0，因此不能假设原生搜索一定自动给出可直接渲染的引用字段。

独立 Search 返回 `title/url/snippet/summary/content/date/authority/rerank_score` 等字段，支持 `site:`、语言和日期过滤；查询最多 128 Unicode 字符。文档标价 Search 与 Fetch 各 $0.75／1000 次成功且有结果的请求，并说明特定服务端工具调用于北京时间 2026-11-01 开始计费。集成应按会产生费用设计，不把当前优惠当作长期承诺。

### 当前项目缺口

- 桌宠已有 [`/api/web-observations`](../src-tauri/src/api.rs) 和 [`web-observations.js`](../src/ai/web-observations.js)，当前只允许 Tavily；设置中有“时下信息”总开关和 Tavily Key。
- [`chat.js`](../src/chat.js) 的 QQ `generate` 仅请求 `/api/chat`，发送人格、召回记忆、短历史和用户文本，没有调用网页观察接口。QQ 电话也未在其专用逐轮路径接入网页搜索。
- 固定中文源的时下缓存、真正按问题搜索网页、抓取指定网页，是三个不同能力，不能相互冒充。

### 推荐接入方式

优先为现有网页观察合同增加 `deepseek` adapter，再把 QQ 明确搜索请求接上同一条链路。先搜索后让当前聊天模型自然回答，保留元元人格和现有记忆召回，无需切换到 Pro，也无需新增 Tavily 账号。

首版限定明确搜索意图：用户文字或语音转写说“搜索／联网查一下……”才触发；成功回复附可核查的来源链接。搜索失败、无结果或未配置时明确说明，不以模型口头宣称充当证据。普通闲聊不每轮搜索，Fetch 正文按确实需要再开放。

复用现有最多 4 条结果、每条／总字符、请求／响应字节、超时和取消边界。适配器需另将查询压到 DeepSeek 的 128 字符限制；不发送整个 Memory 或聊天历史。网页文本只作为不可信的当轮观察，不进入人格、长期记忆、回顾摘要或后续历史。角色基于搜索写出的回答也要与记忆证据隔离，不能只过滤原始网页正文。

Pro 原生工具可作为后续可选方案，但当前 Responses 文档的 `max_tool_calls` 被忽略，需单独验证循环、取消、结果引用和成本控制；不建议为一个搜索功能迁移整个聊天协议。

验收重点：QQ 文字和语音转写都能触发真实搜索；可核对来源；无结果／超时不编造；切换人格、关闭功能时旧请求取消；搜索结果和基于结果的短期事实不会进入长期记忆。

## 3. 用户／角色互发表情

**底层可做，当前 QQ 产品链路尚未接入。** 需要区分三类：

| 类型 | 当前情况 | 建议 |
|---|---|---|
| Unicode emoji，如 😂 | 属于普通 text，现有纯文字路径可以承载 | 保持原样 |
| QQ 内置表情 | OneBot `face` 消息段，带表情 ID | 首先实现；接收转成固定语义标签，发送使用允许列表 ID |
| 自定义表情包、GIF | 通常由 `image` 段承载；不能只靠文件名猜内容 | 结合图片接入；角色先发送项目现有表情库，陌生图按视觉能力识别 |

当前 `qq.rs::owner_text` 要求数组中每段都是 `text`，因此“文字 + 一个 QQ 表情”也会整条拒绝，不是只忽略表情。`owner_record` 只接受单独一条语音。

桌宠已有 [`stickers.js`](../src/ai/stickers.js)、[`stickers.json`](../src/stickers/stickers.json)、`[表情:情绪]` 标记、按情绪挑图和会话内避免重复的逻辑。但 QQ `generate` 会剥除表情标记，文字模式还要求纯文字，语音模式要求不输出贴纸，所以只放宽 Rust 消息解析仍不足以实现双向表情。

建议一起修改接收与回复合同：接受有序的文字／face／image 段；回复保留纯文字与经过允许列表选择的 sticker，不让模型生成任意文件路径或下载 URL。表情和正文共用一次发送结果与记忆证据，避免重复自动整理。语音模式可发语音加表情，表情语义不必再朗读一次。

GIF 的“能发送”“看到某一帧”“理解整个动画”必须分开验证；官方图片格式包含 GIF 并不等于已验证完整动态理解。表情语义可以作为当前对话上下文，但一张表情不能自动推导为用户的长期性格或偏好。

验收重点：单发表情、文字混表情、连续表情、陌生 ID、重复事件和发送失败；自定义 GIF 的动图可播放性另做 QQ 实机验证。

## 4. 图片和视频识别后回复

### 图片：现有能力最容易复用

DeepSeek 官方当前明确支持 `deepseek-flash` 图片输入，Chat Completions 使用 `image_url`（URL 或 base64），支持 JPEG／PNG／GIF／WebP。本文的合成图片实测已通过。

桌宠 [`api.rs`](../src-tauri/src/api.rs) 已有 Flash 原生多模态、Qwen-VL 和本地 VL 路由，桌面聊天也已有图片和 caption 上下文。QQ 的缺口是消息解析、媒体获取、`createQqPrivateChat` 的纯文本事件／生成接口，以及发送成功后的媒体证据合同。

NapCat 上游 `GetImage` 继承 `GetFileBase`，可通过接收到的消息媒体标识解析原消息及媒体元素，下载并返回路径／URL等信息；`GetFileBase` 也处理 `videoElement`。这说明无需另造 QQ 传输协议，但还没有验证本项目端到端获取与识别。

建议首版支持单图、多图上限和图文混合：校验已绑定主人的消息身份与消息 ID 后，获取该消息对应媒体，按类型／解码像素／字节上限压缩，复用桌宠视觉配置，再由当前人格结合问题和 Memory 回复。已有 Flash 文本模型可直接看图；其他文本模型复用视觉描述再回答。不要只取附带文字而丢掉图片，也不要把事件携带的任意 URL 或文件路径直接交给下载器。

图片中的文字、caption 和模型推测均是观察；不能把截图中别人说的话视为主人自述。用户明确补充“这是我的猫，叫……”才可按既有记忆策略提取有来源的用户事实；不默认长期保存原图。

### 视频：可行，但需要单独的处理链路

OneBot 有独立 `video` 消息段。此次核对的 DeepSeek 视觉文档只确认图片输入，**没有建立原生视频文件加音轨的支持证据**；不能直接把 MP4 当作 image_url。

项目的 [`scripts/mage-vl/server.py`](../scripts/mage-vl/server.py) 已有 `/observe-video` 和 `/observe-frames` 代码：前者用 OpenCV 抽最多 4 帧，后者处理 2～4 帧时间窗；[`shared_experience_visual.rs`](../src-tauri/src/shared_experience_visual.rs) 也有有界帧窗。这是可复用的抽帧／观察经验，不代表 QQ 已经接通，更不等于完整理解长视频或声音。

推荐首版只做有明确时长和体积上限的短视频，例如以 60 秒／20MiB 作为待实现时校准的起始限制，而非现有承诺。流程为：取原视频 → 检查容器、时长和尺寸 → 带时间戳抽取有界关键帧 → 用视觉模型描述变化 → 必要时单独提取音轨并 ASR → 当前人格结合用户问题回答。

需要保留“看见什么”“转写到什么”的来源区分；只有关键帧时明确可能遗漏细节，没有分析音轨时不宣称听见内容。QQ 语音消息现用的 `fetch_ptt_text` 不等于视频音轨 ASR；视频需独立转码及调用已有可用 ASR 后端。Mage-VL 属于可选本地能力，首版不应强迫用户安装新模型才能处理图片或短视频。

后续可扩展到长视频分段或“共同观看”，但不纳入首版 QQ 附件识别。B 站／网页分享卡片是另一类链接输入，不等于上传的视频附件，需单独支持，不能声称同一实现已经覆盖。

验收重点：图文混合与上下文追问；多图对应关系；过期媒体、损坏／超限文件、下载／模型失败有反馈；视频时间顺序、静音／有音轨分支；取消或切换身份后不晚发回复、不写错记忆；最后分别验证 macOS 与 Windows QQ 实机链路。

## 5. 建议推进顺序

| 顺序 | 工作 | 完成后的用户感知 |
|---|---|---|
| 1 | 小范围优化记忆准入、同源召回与电话回合聚合 | 减少重复条目，保留真实共同经历和已听到的回复 |
| 2 | DeepSeek Search adapter + QQ 明确搜索 | “帮我联网查一下……”有真实结果和链接，当前模型／人格继续使用 |
| 3 | QQ 内置表情 + 角色现有表情库；同步扩展消息段合同 | 表情消息不再无声丢弃，元元能回应和发表情 |
| 4 | QQ 单图、多图及图文混合 | 发照片／截图就能问，沿用桌宠视觉设置与 Memory |
| 5 | 有界短视频、抽帧及可选音轨 ASR | 对短视频内容作有依据的回复 |

也可把第 3～4 项作为同一阶段的两个纵向切片，共用媒体获取和发送合同。避免每个新能力都复制一套人格、历史和记忆逻辑；复用当前桌宠能力，以来源明确的类型化事件进入 QQ 对话。

本轮已验证的是官方 Search、Fetch、Pro 原生 web_search 和 Flash 合成图片；未实施或宣称通过 QQ 表情／图片／视频 E2E。本轮为文档调研，没有功能变更，不运行功能全量门禁，也不提交或推送。

## 一手来源

- [DeepSeek Search & Fetch 指南](https://api-docs.deepseek.com/guides/search)：端点、鉴权、参数、响应、计费、重试条件。
- [DeepSeek Search API](https://api-docs.deepseek.com/api/search)：搜索接口参考。
- [DeepSeek Responses 指南](https://api-docs.deepseek.com/guides/responses_api)：Pro 的 web_search、Flash 忽略该工具、工具使用事件、忽略 max_tool_calls 等兼容边界。
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)：当前聊天工具字段只支持 function。
- [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision)：Flash 图片能力、格式、输入方式及限制；不能据此推断视频音轨支持。
- [OneBot 11 消息段规范](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)：text、face、image、record、video 的收发定义。
- [NapCat GetImage](https://github.com/NapNeko/NapCatQQ/blob/ba0a53dd372dbc4c4bfc83cf7132997459605210/packages/napcat-onebot/action/file/GetImage.ts)、[GetFile](https://github.com/NapNeko/NapCatQQ/blob/ba0a53dd372dbc4c4bfc83cf7132997459605210/packages/napcat-onebot/action/file/GetFile.ts)、[SendMsg](https://github.com/NapNeko/NapCatQQ/blob/ba0a53dd372dbc4c4bfc83cf7132997459605210/packages/napcat-onebot/action/msg/SendMsg.ts)：2026-10-29 检查的上游源码快照；具体已安装版本的所有媒体形式仍需实机验收。
