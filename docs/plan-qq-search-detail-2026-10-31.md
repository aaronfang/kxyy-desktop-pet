# QQ 搜索资料与语音分流

## 验收

- 搜索回答先发简短语音（文字模式先发概括），确认发送后再发文字资料卡，包含逐项说明、真实来源链接、可用的发布时间和阅读范围。
- 链接只取自本轮已校验搜索结果；语音不朗读网址。搜索资料不进入长期记忆或后续普通聊天历史。
- 优先相关的一手技术资料、论文和官方说明；同网址去重。首次资料不足时最多补充一轮搜索，两家服务均可回退，全部搜索共享 24 秒期限。
- 正文可用时使用有界正文摘录；不可用时明确标注“仅搜索摘要”。抓取时间不冒充发布时间，页面摘录不冒充完整论文阅读。
- 原始回复格式异常、空结果、超时、取消、新消息、重复/未知 ACK、语音确定失败回退、后续文字失败均不导致重发已确认内容或错存记忆。

## 官方依据

- [DeepSeek Search](https://api-docs.deepseek.com/zh-cn/api/search)：`need_content`、`content`、`date`、`authority`、`rerank_score`。
- [DeepSeek Fetch](https://api-docs.deepseek.com/zh-cn/api/fetch)：固定服务支持页面正文。本实现优先使用 Search 返回的正文，不增加任意 URL 抓取入口。
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)：`include_raw_content` / `raw_content`，结果可带 `published_date`。

## 边界与验证

QQ 按轮启用研究路径，其他桌面摘要契约保留。最多两轮、每轮最多两个服务尝试；每个响应最多 1 MiB，最多保留三条资料，每条正文摘录最多 2200 字。外部资料始终是不可信数据，不进入日志、诊断、Memory。

先增加失败回归，再实现原生检索、前端分流和有序发送；运行受影响 JS/Rust 合同测试与完整 `npm run test:gate`。使用真实服务验证检索和生成，实际 QQ 显示/播放仍需实机确认；macOS/Windows 不得相互代替验收。

## 本轮实现与验证结果

实现位于 `src-tauri/src/web_research.rs`、`src/ai/web-observations.js`、QQ 控制器及原生发送队列。原生排序综合问题方向、技术词匹配、来源类型、可用日期、正文及 DeepSeek 的有界质量字段。首次选材不足最多补充一轮，先使用本轮已成功的服务，避免重复等待已失败服务。另有先失败后通过的范围回归：泛 AI 资讯保留机器人/扩散等相关方向，明确大模型问题仍过滤无关领域。

文字详情由模型逐项解释，真实标题、链接、日期、阅读范围由应用附加。模型自行生成的网址会被移除；格式异常、字段类型异常或缺少逐项说明时，改用本轮来源摘录，不将原始 JSON 朗读出来。普通表情和语音互斥规则保留，搜索资料不和表情组合发送。

实际执行：

- 新行为先通过失败测试复现缺失的正文元数据、语音/资料分流及原生资料队列，再实现；覆盖错误 JSON/字段、注入、伪造链接、空结果、重复来源、未来日期、共享期限、服务回退、取消及普通聊天隔离。
- `node --test tests/observation.test.js tests/qq-private-chat.test.js` 通过。实际 `chat.js` 的 VM 集成测试确认 `research:true`、概括进入 `text`、资料进入 `details`、`external:true` 进入原生 Memory 边界。
- 最终 `npm run test:gate` 通过：预检 JS 38 项，主 JS 608 项；Python、资源合同、Rust 编译检查通过；Rust 258 passed / 2 既有 ignored。Python 保留1项既有 skip。
- 三次真实开发版代理＋真实搜索＋真实模型探测（末端 QQ 发送替换为记录，不向真人发消息）均得到3条资料、3条正文摘录；发布时间可用2–3条。模型实际看到全部3条资料，语音概括160–203字，文字资料1237–1375字，均附来源和阅读范围；本轮约6–14秒。Tavily 超时场景自动回退 DeepSeek。只保留计数/时间等探测结果，不将网页正文或私人内容写入报告。
- macOS 真实 Tauri 应用／WebView／本地代理／原生 QQ command／模拟 OneBot 的隔离 E2E 通过：正常 `record → text`；语音确定失败 `record → text概括 → text资料`；资料失败返回 partial 且不重发语音；第一条语音尚未回执时新消息到来，旧资料取消，新回复正常。使用独立应用标识、合成主人/小号、搜索与音频夹具，没有连接真人账号或发送真人消息。测试证实只有概括进入 TTS。
- 隔离数据库复核：events、evidence、jobs、facts、episodes、commitments、entities、topics、edges 均为0，未将搜索问答写入记忆。`git diff --check` 通过；测试专用入口只在临时副本，未加入项目。

剩余实机验收：真实 QQ 客户端中确认语音可播放，文字资料显示在其后且链接可点开；Windows 未运行本轮原生 E2E，安装包未重打。当前开发版已载入修改，未提交、未推送。正文来自提供商返回的页面摘录，不保证获得全文、PDF 或所有来源的发布日期；服务不可用仍会按真实失败原因说明。
