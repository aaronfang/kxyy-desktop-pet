# 桌面陪聊的近期互联网信息来源与预取架构调研

日期：2026-08-08  
范围：本地实时语音优先，之后与文字聊天共用；只研究信息获取与供给，不改变 persona、Memory 或实时协议。

## 结论

推荐采用三层来源，而不是寻找一个“免费 Tavily 替代品”：

1. **启动预取：经书面许可或开放许可确认的原站 RSS/Atom + GDELT DOC API。** RSS/Atom 是传输格式，不是内容许可；2026-08-08 的大陆来源专项复核没有找到一个同时满足“生活类、近期、无 Key、官方、明确允许本 App 使用”的综合中文 feed，因此首版不能把“公开可访问”等同于“可随产品使用”。GDELT 可作为有界元数据发现层，但实测会返回 429，不能成为唯一来源。
2. **按需检索：继续保留 Tavily。** 将免费额度留给“最近有什么好看的电影”这类用户即时问题，并按意图设置 `topic`、`time_range`、`country`，而不是永远使用无时间约束的 `general/basic`。
3. **垂直补充：HN、Wikinews/MediaWiki 等只能在用户明确表达对应类别意图后使用。** HN 不参与启动预取或默认闲聊池；只有用户主动聊科技时才能查询。TMDB 对电影数据很好，但免费开发者 API 只允许非商业使用；Google News RSS 明确只允许个人、非商业 feed reader，均不能未经许可成为商业发布版默认源。

启动预取可以做，但必须继续受现有“网页观察”显式开关控制。App 启动不等于获得联网同意。缓存应是独立的短期外部观察缓存，不能写入 Memory、persona、诊断正文或模型训练数据。

## 1. 为什么当前 Tavily 看起来没有工作

“最近有什么好看的电影”**会命中当前前端触发器**：`最近` 在正则中（[`src/ai/web-observations.js:8`](../src/ai/web-observations.js#L8)），启用且 provider 为 `tavily` 时会请求本地 `/api/web-observations`（[`src/ai/web-observations.js:68`](../src/ai/web-observations.js#L68)）。因此，这个例子的问题不太可能是关键词本身。

更可能的断点如下：

- 只接入了**普通文字回复**；`proactiveKind` 存在时明确跳过，实时语音链路也没有调用该模块（[`src/chat.js:1464`](../src/chat.js#L1464)）。所以“元元带聊”不会从 Tavily 获得话题。
- Rust 固定发送 `topic:"general"`、`search_depth:"basic"`，没有 `time_range`、`start_date`、`country` 或 `auto_parameters`（[`src-tauri/src/api.rs:921`](../src-tauri/src/api.rs#L921)）。它能搜索，但没有要求“电影推荐必须来自最近一周/月或中国地区”。
- Tavily 官方 Search API 本来支持 `topic=news`、`time_range=day|week|month|year`、起止日期，以及仅在 `general` 下可用的 `country` boost；`news` 被官方描述为适合实时主流新闻，`general` 是广泛检索。[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- 当前归一化丢弃了 Tavily 结果中的来源发布时间，只记录本机的 `fetchedAt`（[`src-tauri/src/api.rs:979`](../src-tauri/src/api.rs#L979)）。模型看见的是“何时抓取”，并不能可靠判断文章“何时发布”。
- Rust 上游超时为 4 秒，前端总超时为 5 秒；HTTP、超时、额度、鉴权和响应解析失败都被收敛成空数组（[`src-tauri/src/api.rs:935`](../src-tauri/src/api.rs#L935)，[`src/ai/web-observations.js:87`](../src/ai/web-observations.js#L87)）。生产上安全，但用户只能看到模型在无资料时搪塞，无法区分“没有结果”和“provider 失败”。
- 设置必须同时满足启用、选择 Tavily、填写 Key；保存页会检查这些条件（[`src/settings.js:703`](../src/settings.js#L703)）。本调研没有用户 Key，不能替用户复现账户、额度或网络错误。

### Tavily 能否回答近期电影问题

能作为搜索层使用，但“好看”是主观排序，不是单一事实。建议把请求拆成：

- 中国院线/流媒体近期片单：`topic=general`，`time_range=month`，`country=china`，查询中写明地区、院线或平台；
- 电影相关新闻：`topic=news`，`time_range=week|month`；
- 对多个来源做去重，再让模型明确区分“近期上映/热度”和“元元基于资料给出的推荐理由”。

不要开启 `include_answer` 或 `include_raw_content`：当前只需要短来源片段，且已有 4 条/响应大小/注入长度边界。官方文档称 `basic`、`fast`、`ultra-fast` 每次 1 credit，`advanced` 每次 2 credits；免费方案为每月 1,000 credits、无需信用卡，按量价当前为每 credit 0.008 美元。[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)；[Credits & Pricing](https://docs.tavily.com/documentation/api-credits)；[Pricing](https://www.tavily.com/pricing)

这意味着免费层约可承受 1,000 次 basic 搜索/月。若每次启动都用 Tavily 拉多个栏目，额度会被无意义消耗；启动预取宜用 RSS/GDELT，Tavily 留给按需查询和缓存未命中。

## 2. 免费/开源来源矩阵

| 来源 | Key / 成本 | 时效与中文现实 | 商用/许可和稳定性 | 建议 |
|---|---|---|---|---|
| 原站 RSS/Atom | 通常无 Key、无 API 费 | 取决于发布者；中文应选在中国大陆可达的原站栏目 | RSS/Atom 只是格式，不自动授予内容版权；Atom 甚至有单独的 `rights` 字段。需逐 feed 审核条款，尊重 `ETag`/`Last-Modified`/缓存头 | **默认启动层首选**；固定白名单，仅保存标题、链接、时间和短摘要 |
| GDELT DOC 2.0 | 无 Key、无 API 费 | DOC API 支持文章列表、JSON/RSS/JSONFeed、最短 15 分钟窗口；GDELT 称其跨语言系统覆盖 65 种机器翻译语言。中文发现能力广，但结果质量和源站可达性仍需实测 | GDELT 官方允许其发布的数据集免费用于学术、商业和政府用途，要求引用及链接；源站文章本身仍不应整篇复制。没有承诺 SLA | **默认发现层推荐**；只拿元数据/标题/URL/时间，限制查询和结果数 |
| Google News RSS | 无 Key、无 API 费 | `hl=zh-CN&gl=CN&ceid=CN:zh-Hans` 当前可返回中文聚合结果，但 Google 在中国大陆的可达性不可靠 | feed 自身版权声明明确：仅用于个人、非商业 feed reader，其他用途禁止；也没有公开的产品 API/SLA | **不要作为发布版默认源**；个人本地实验也需遵守限制 |
| RSSHub | 自托管无 API 费；服务代码 AGPL-3.0 | 中文站点路由丰富；官方文档建议长期稳定使用时自托管 | 自托管仍可能被上游反爬/页面改版影响；RSSHub 代码许可不等于上游内容许可 | 可做**高级用户自托管适配器**，不把公共实例当基础设施 |
| Hacker News Firebase API | 无 Key；官方 README 称当前无速率限制 | 近实时、最多 500 条 top/new/best；英文科技圈非常集中，不适合家常、影视或中文综合内容 | v0 可能有不兼容变化；用户内容没有被 API README 授予开放再许可 | 作为可选“科技话题”源；取标题、URL、分数，不抓评论全文 |
| MediaWiki / Wikinews | 通常无 Key | 可结构化查询；Wikipedia 当前事件是二次整理，Wikinews 的中文更新密度现实中很低，不能承担热榜 | Wikimedia 内容有开放许可，但必须按具体站点/页面履行署名、相同方式共享等要求；API 需要良好 User-Agent、缓存和温和请求 | 仅作补充背景/事实入口，不作主要新鲜话题源 |
| Reddit Data API | OAuth；免费不等于可商用 | 社区话题强，但中国大陆可达性差，中文覆盖弱 | 官方条款要求商业用途另签协议；禁止未经权利人许可将用户内容用于 AI 训练，并保留收费权 | **不纳入默认方案** |
| TMDB API | 需 Key；开发者用免费 | 有地区、语言、上映、流行度和 trending 等结构化电影数据；适合“最近电影”候选，但不是新闻或影评事实核验 | 官方 FAQ：免费仅限非商业并须署名；商业项目联系销售；无 SLA | 仅用于非商业原型，发布前必须拿商业许可或移除 |
| SearXNG | 可自托管；AGPL-3.0 | 元搜索可覆盖多个引擎，中文取决于上游 | 自托管软件免费不代表上游搜索结果/API 获得授权；易遭上游 bot 限制，运维成本高 | 不作为 MVP；只能是用户自管高级 provider |

### 一手来源

- Atom 格式和 `rights` 语义：[RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)
- GDELT DOC 2.0 的模式、时间范围、跨语言和 JSON/RSS：[GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- GDELT 数据集的无限制学术/商业/政府使用及署名要求：[GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse)
- Google News RSS 的限制直接写在 feed 的 `<copyright>` 中，可用[中文电影查询 feed](https://news.google.com/rss/search?q=%E7%94%B5%E5%BD%B1&hl=zh-CN&gl=CN&ceid=CN:zh-Hans)复核；Google 通用条款也说明 Google News 中第三方报道未经许可不得使用：[Google Terms](https://policies.google.com/terms?hl=zh-CN)
- RSSHub 官方仓库为 AGPL-3.0，官方指南建议稳定长期使用时自托管：[RSSHub](https://github.com/DIYgod/RSSHub)；[Guide](https://docs.rsshub.app/guide/)
- HN 近实时、v0 兼容声明、无速率限制及 top/new/best 最多 500 条：[Official HN API README](https://github.com/HackerNews/API)
- Reddit 商业使用须另签协议、用户内容显示范围和 AI 训练限制：[Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)
- TMDB 非商业免费、署名、商业许可和无 SLA：[TMDB API FAQ](https://developer.themoviedb.org/docs/faq)
- MediaWiki API 入口与请求规范：[MediaWiki Action API](https://www.mediawiki.org/wiki/API:Main_page)；[API Etiquette](https://www.mediawiki.org/wiki/API:Etiquette)
- SearXNG 自托管文档及 AGPL 源码：[SearXNG docs](https://docs.searxng.org/)；[source](https://github.com/searxng/searxng)

## 3. 推荐架构

### 3.1 一个 Rust 管理的 `FreshTopicService`

把来源获取、缓存、限额和清洗放在 Rust 主进程，文字与实时通话只消费同一结构化接口。API Key 不进入 WebView，远端 URL 不由模型决定。建议固定接口语义：

```text
prefetch_generic_topics(reason=startup|scheduled)
get_cached_topics(categories, max_items)
search_current_topic(query, category, deadline_ms)
```

adapter 输出统一为：`sourceId`、`sourceName`、`canonicalUrl`、`title`、`publishedAt?`、`fetchedAt`、`shortText`、`category`、`locale`。必须分开 `publishedAt` 和 `fetchedAt`，不能再用抓取时间冒充发布时间。

### 3.2 启动与刷新时机

1. App 启动、设置加载完成后，只有 `webGroundingEnabled=true` 才启动任务；随机延迟 5–20 秒，绝不阻塞窗口、语音服务或本地模型预热。
2. 先读磁盘缓存，缓存仍新鲜时直接可用；后台使用 RSS 条件请求和 GDELT 增量窗口刷新。
3. 建议刷新：突发/综合新闻 2 小时，影视/游戏/科技 6–12 小时，文化/生活 24 小时；失败指数退避并加 jitter。不要固定分钟全体客户端同时打上游。
4. 每次候选池最多 50 条，最终话题种子 8 条；每类最多 2 条、每来源最多 2 条。超过 7 天的“近期”候选硬过期。
5. Tavily 不参与常规启动轮询。缓存未命中且用户明确提出时效问题时才调用；可设置每安装每日软上限和每月预算显示。

### 3.3 去重与排序

- 第一层：解析并规范化 URL，去跟踪参数；同 canonical URL 合并。
- 第二层：规范化标题后做近重复聚类；同一事件保留可信度较高且发布时间明确的来源，并保存最多 2 个交叉来源。
- 排序只使用可解释信号：时间衰减、来源等级、跨来源佐证、类别多样性、与本轮话题相关性、当前会话未使用过。热度只能作为一个信号，不能把争议和耸动自动当成“好话题”。
- 推荐理由应是模型基于观察生成的观点，不应伪造评分、口碑共识或元元亲历。

### 3.4 实时语音接入

- 通话开始时只让前端拿到缓存池摘要，不把全部新闻塞进 persona/system prompt。
- 元元要换话题时，从池中选一个尚未使用的种子，再把最多 3 条/300 字的观察交给本地/CosyVoice 下一次 LLM 请求；沿用现有 Memory 动态 context 的有界请求/超时模式，但使用独立 `reason`，不得写入 Memory。
- 用户问“最近有什么好看的电影”时，先匹配缓存；若不足，在回复生成前并行做一次有 deadline 的按需 Tavily/GDELT 查询。超时就诚实说明当前资料未取到，不能静默让 persona 用“没关注”伪装成成功搜索。
- 文字聊天调用同一 service。这样以后统一的是“来源、缓存和选择策略”，不是把实时协议硬搬到文字端。

## 4. 安全、隐私和提示注入边界

- 沿用现有 `observation` 语义：网页文字始终是不可信数据，不能成为指令，不能修改 persona、system、skill、Memory 或工具权限。
- 只保存标题、URL、来源、发布时间、抓取时间和短文本；不缓存整页，不导出到实时诊断，不写聊天长期记忆。会话使用记录只需 topic id/类别，正文不进 trace。
- 启动预取只用固定通用栏目，不发送用户聊天、Memory、persona、联系人或设备信息。按需检索只发送当前必要查询；设置页需明确说明查询会发给所选 provider。
- 固定 HTTPS provider 和 feed 白名单。若未来允许自定义 RSS，必须单独处理 SSRF：拒绝 loopback/私网/link-local、限制 DNS 与重定向、限制响应大小和超时、禁用 XML 外部实体，并在每次重定向后复核目标。
- 对来源文本先解析 HTML/XML，再做长度、Unicode 控制字符、URL、时间和固定字段清洗；不要用字符串拼接解析 feed。
- 显示或说出当前事实时保留来源名和时间；语音可简短说来源，聊天窗提供链接。涉及政治、灾害、健康、金融等高风险内容至少要求两个独立来源，或明确说“目前只有单一来源”。

## 5. 中国用户与中文内容的落地顺序

1. 首版只接入已经取得书面许可或具有明确开放许可、在中国大陆可达且栏目稳定的中文原站 RSS/Atom。2026-08-08 的专项复核没有找到可直接批准的综合生活类 feed；在取得许可前宁可让该 adapter 为空，也不能用网页抓取或公开 RSS URL 替代授权。
2. 用 GDELT 做跨来源补充，但上线前从中国大陆网络实测 DNS/TLS、延迟、中文查询命中、来源质量和失效降级；不应把其“覆盖 65 种翻译语言”的官方描述当成中文质量保证。
3. Tavily 作为用户自带 Key 的按需增强。中文查询显式带中国地区/平台/院线语境；设置 `time_range`，保留来源发布时间，并给设置页增加不含正文的固定状态：`ready|quota|auth|timeout|provider_error`。
4. Google News、Reddit、YouTube 等在大陆网络和许可上都有硬伤，不作为默认依赖。RSSHub 只作为高级自托管选项。
5. 电影场景先用“中文影视 RSS + GDELT + 按需 Tavily”验证体验。TMDB 只在确认项目非商业或取得商业许可后加入。

## 6. 建议的最小验证

在实现前准备固定查询集并保留**不含正文**的结果指标：

- `最近有什么好看的电影`、`最近有什么值得聊的游戏新闻`、`今天科技圈有什么有意思的事`；
- 每个查询检查：是否真的发起 provider、固定状态、耗时、结果发布时间覆盖率、中文结果比例、近重复率、跨源事件数、缓存命中和过期行为；
- 用 20–30 段语音回放检查：元元是否先贡献具体信息、是否标注不确定性、用户短回应后能否沿同一话题深入三轮、是否避免把新闻摘要读成播报稿；
- 分别在中国大陆网络、海外网络、离线、Tavily Key 错误、额度耗尽、RSS 304、GDELT 超时下测试。任何 provider 失败都不得阻塞通话。

## 决策建议

可以进入规格设计，但不要直接把更多 URL 塞进 prompt。首个实现切片应是：**修复 Tavily 可观测性和时间参数 + 独立短期 topic cache + 一个审核过的 RSS adapter + GDELT adapter + 本地实时通话缓存命中**。等这个切片通过固定查询和三轮深聊回放，再扩来源或做更复杂的“对话导演”。

## 7. 中国大陆生活类来源专项复核（2026-08-08）

本节纠正前文中“找一个审核过的中文 RSS 即可上线”的过宽假设。验证从当前开发环境直接请求官方端点，只记录 HTTP 状态、格式、大小、缓存头和发布时间，不下载正文页面。单次可达不代表中国大陆不同运营商均可达，也不构成 SLA。

### 7.1 实测候选

| 候选 | 本次可达性与格式 | 权利/稳定性证据 | 发布结论 |
|---|---|---|---|
| 中国新闻网 RSS | 官方[订阅页](https://www.chinanews.com.cn/rss/)列出了即时、国内、社会、生活、健康、文化、体育等 RSS 2.0；`life.xml`、`society.xml`、`culture.xml`、`sports.xml` 均为 HTTPS 200，并带 `Last-Modified`/`ETag`。生活 feed 14 条，社会/文化/体育各 30 条；健康 feed 虽可达，但本次最新条目停在约 5 个月前，栏目新鲜度不能只看 HTTP 成功 | 官方[法律声明](https://www.chinanews.com.cn/common/footer/law.shtml)第 1 条明确称，未经书面授权不得“转载、链接、转贴或以其他方式使用”；官方提供 RSS 订阅入口并没有同时授予本 App 再利用权 | **不默认接入**。它是内容匹配度最高的候选，但必须先获得书面授权并明确是否可缓存标题、链接、发布时间和用于 LLM 观察；获准后只取这些元数据，不取 description/正文 |
| 国家气象中心预警 JSON | `https://www.nmc.cn/rest/findAlarm?pageNo=1` 一次返回 HTTPS 200、JSON、CORS `*`，含 `alertid/issuetime/title/url/pic`；随后一次 15 秒超时。端点没有公开版本、配额或兼容性契约 | 国家气象中心页脚明确写明“本站所刊登的信息、数据和各种专栏材料，未经授权禁止下载使用”，并提供商务合作邮箱；公开网页内部 JSON 不等于开放 API | **不接入**，除非国家气象中心书面授权。即使授权，也只适合基于用户位置/关注地的预警，不适合普通聊天新闻池 |
| 中国政府网 | 猜测的 `https://www.gov.cn/rss/index.htm` 返回 404，未验证到当前官方 RSS 目录 | 官方[版权声明](https://www.gov.cn/home/2014-02/23/content_5046258.htm)禁止媒体、网站和商业机构商业性原版原式转载，也要求转载第三方内容时向相应单位取得授权 | **不做 HTML 抓取**。政务原文可在用户明确问政策时按需链接核验，但它不是生活话题预取源 |
| 新华网旧 RSS | `https://www.xinhuanet.com/politics/news_politics.xml` 返回 RSS 2.0，但 `Last-Modified` 为 2022-12-14，不能视为当前 feed | 新华网页脚明确写明未经协议授权禁止下载使用 | **不接入**：既不新鲜，也无使用授权 |
| 文化和旅游部 | [焦点新闻](https://www.mct.gov.cn/whzx/whyw/)和[出行提示](https://www.mct.gov.cn/ggfw/cxts/)均返回 200 HTML 和 `Last-Modified`；前者含文旅活动/消费提醒，后者含公路气象、旅游安全和使领馆提醒，但会混入境外信息 | 只能依赖页面结构抓取；没有发现允许自动再利用的开放许可或稳定接口说明 | **不接入启动预取**。它们是适合生活类的待授权元数据候选，但不能包装成稳定 feed；用户显式搜索时可作为一手核验目标 |
| 中国疾控中心 | [健康提示](https://www.chinacdc.cn/jkts/)与营养健康栏目均返回 200 HTML、UTF-8 和 `Last-Modified`，有按月健康风险提示等生活内容 | 官方[免责声明](https://www.chinacdc.cn/mzsm/202410/t20241028_302192.html)对中心稿件、转载稿以及转载/链接/复制方式分别设置条件；没有找到允许摘取后改写为模型摘要的开放许可或稳定 API 契约 | **不接入启动预取**。健康信息风险较高；在得到对“标题/日期/链接缓存及模型观察”的明确许可前，只能作为用户显式查询的一手核验目标 |
| 国家卫健委 | 新闻列表请求在本环境返回 412/WAF 页面 | 无稳定机器接口、格式或配额契约可验证 | **不接入**；健康内容风险高，不能依赖脆弱抓取，并应优先一手来源与明确日期 |
| 国家体育总局 | 一个旧栏目 URL 只返回 332 字节旧页面；进一步核验到当前[今日体坛](https://www.sport.gov.cn/n20001280/n20745751/index.html)返回约 417 KB HTML 和 2026-08-06 `Last-Modified`，含全民健身、冰雪运动等 | 页脚标注国家体育总局版权所有，未找到开放许可、RSS/API 或兼容性契约 | **不接入启动预取**。可列为待授权的标题/日期/链接候选；用户明确聊体育时优先使用获许可的按需搜索 |
| Open-Meteo Free API | 官方文档和 API 当前 HTTPS 可达、无需 Key | 官方[使用条款](https://open-meteo.com/en/terms)限定 Free API 每日低于 10,000 次且仅限非商业；订阅、广告或商业产品被明确归入商业使用，需要付费方案。数据按 CC BY 4.0 署名，但免费托管服务的商用限制仍然存在 | 仅可用于确认属于非商业且完成署名的构建；**不能作为通用发布版的无成本天气源** |

`robots.txt` 允许抓取只能说明爬虫路径偏好，不能覆盖上述版权/合同声明，因此不作为授权依据。

### 7.2 GDELT 的现实边界

GDELT 的数据使用条款仍是本轮唯一验证到明确允许商业使用的新闻元数据来源，但当前环境对两次中文生活类 DOC API 查询均在约 10–11 秒后返回 HTTP 429，正文要求请求间隔至少 5 秒。这个结果与现有缓存最终只剩 HN 的现象一致：GDELT 失败时，当前无条件 HN adapter 会把缓存退化成全英文科技内容。

若继续使用 GDELT：

- 启动时最多发送一个合并后的中文生活查询，类别优先 `lifestyle/general/culture/movies`，查询中限定中文/中国来源语境；不得并行按多个类别轰炸端点。
- 尊重至少 5 秒的 provider 间隔，429 后指数退避；成功缓存应按小时复用，失败保留旧缓存，不能回退到无关类别。
- 只保存 GDELT 提供的标题、域名、URL、发布时间和抓取时间，不抓取或复制源站全文；向用户呈现时保留来源。
- 由于没有 SLA 且当前环境实际 429，发布版必须接受“本次没有新鲜话题”的状态，不能为了填满缓存自动启用 HN。

### 7.3 类别路由的产品约束

默认预取池应以中国大陆日常生活为主：生活服务、美食、旅行、文化展览、影视和轻体育；不主动预取政治、灾害、医疗建议、金融投资或科技。这里的“生活类”必须来自固定分类和查询模板，不能仅靠标题分类器把综合新闻事后猜成生活类。

HN 和任何英文科技 feed 的开关条件必须是用户当前消息明确表达科技意图，例如 AI、手机、芯片、软件、数码或具体科技产品。它们不参与应用启动预取，不作为通话开场候选，也不能在中文生活源失败时兜底。用户表达电影、旅行、健康等意图时，只查询对应类别；健康类只能提供带来源和日期的一般信息，不生成诊断或治疗建议。

### 7.4 可以立即执行的工程决策

1. 从默认启动预取中移除 HN；保留为“明确科技意图”的按需 adapter。
2. 将启动模板改为单个中文生活类 GDELT 查询，并正确处理 429、超时和旧缓存；若没有合格结果，缓存可以为空。
3. 不把本节任何“拒绝接入”的网页/RSS/API 填入白名单。可先联系中新网和国家气象中心确认元数据缓存、LLM 上下文使用、来源展示、调用频率和商业/非商业分发边界。
4. 若测试版必须立即获得稳定中文内容，应让用户配置已有明确合同的搜索 provider，或把“中国生活类默认源”标为 beta/不可用；不能用无授权抓取伪装成免费正式方案。

## 8. 自用优先的五来源方案（2026-08-08 补充，历史阶段记录）

> 本节记录五来源阶段的调研假设，不是当前运行规范。2026-08-09 的实现复核、来源清单、偏好配额和授权决策以第 9 节及仓库根目录 `AGENTS.md` 为准；其中旧的 `neutral=3/interested=6`、11 来源和机核/下厨房默认路由均已被后续实现取代。

本节响应新的产品约束：当前项目以个人自用为主，来源授权边界暂不作为阻断条件，优先保证中国大陆内容的匹配度、分类覆盖和可用兜底。第 7 节的权利证据仍然保留；若以后公开分发或商业化，应重新启用那一节的准入门槛。

### 8.1 推荐固定来源集

推荐恰好接入五个固定 adapter，不让 GDELT 或 HN 参与默认预取。五个来源均在本开发环境以无 Key 请求实测；这里的“可达”只代表本次网络，不代表所有大陆运营商或长期 SLA。

| adapter | 固定端点与本次实测 | 主分类 | 兜底分类 | 来源性质与风险 | 建议状态检查 |
|---|---|---|---|---|---|
| `china_news_rss` | 中新网官方[RSS 订阅目录](https://www.chinanews.com.cn/rss/)；`life.xml` 本次 HTTPS 200、14 条，`culture.xml`、`health.xml`、`sports.xml`、`society.xml` 各 30 条；均含 `title/link/pubDate`。`life.xml` 返回 `ETag`、`Last-Modified`，携带 `If-None-Match` 实测得到 304 | `lifestyle`、`culture` | `movies`、`health`、`sports` | 官方 RSS，中文大陆内容最匹配；授权限制见 7.1。健康条目只能作为一般资讯，不能转成诊断建议 | 对每个实际启用的 feed 分别记录 `ready/not_modified/http_error/timeout/parse_error/stale`、条目数和最近发布时间 |
| `baidu_hot` | 百度热榜页面及同域 JSON：[`platform=pc&tab=realtime`](https://top.baidu.com/api/board?platform=pc&tab=realtime) 本次 HTTPS 200、JSON、50 条；[`tab=movie`](https://top.baidu.com/api/board?platform=pc&tab=movie) 为 10 条。PC 响应字段包括 `word/desc/hotScore/url`，UTF-8 正常；`platform=wise` 本次出现字符集错标，不应使用 | `lifestyle`、`general`、`movies` | 无 | 百度内部未公开文档的页面接口，没有发布时间、版本或配额契约；只能表示“当前热议/榜单”，不能作为事件事实的唯一依据。`game` tab 实测返回 `no found page` | `ready/http_error/timeout/parse_error/schema_changed`；另显示 `no_published_time`，刷新成功不等于内容已被事实核验 |
| `bilibili_popular` | 哔哩哔哩同域 JSON [`/x/web-interface/popular?ps=20&pn=1`](https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1) 本次 HTTPS 200、`code=0`、20 条；每条有 `title/tname/pubdate/bvid/desc`。综合榜 [`ranking/v2`](https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all) 也返回 100 条，但首版不需要同时请求 | `lifestyle`、`culture`、`games`、`movies` | `technology` | B 站内部未公开契约的 JSON，内容是用户创作与热度信号，不等同新闻。只采标题、分区、发布时间和规范化视频链接；不要把长 `desc` 放进 LLM 上下文 | `ready/http_error/timeout/parse_error/schema_changed/rate_limited`；条目按固定 `tname` 白名单映射分类，未知分区跳过而非猜测 |
| `ithome_rss` | IT之家首页通过 `rel=alternate` 链接到官方 [`/rss/`](https://www.ithome.com/rss/)；本次 HTTPS 200、RSS 2.0、60 条，含 `title/link/pubDate`，最近条目在请求前约 2 分钟；携带 `If-Modified-Since` 实测得到 304 | `technology` | `science`、`games`、`digital` | 官方 feed，科技更新快但消费电子/汽车占比较高；不能作为生活类失败后的通用填充 | `ready/not_modified/http_error/timeout/parse_error/stale`；显示最近发布时间，避免“HTTP 正常但 feed 停更” |
| `gcores_rss` | 机核首页直接链接官方 [`/rss`](https://www.gcores.com/rss)；本次 HTTPS 200、RSS 2.0、20 条，含 `title/link/pubDate`，最新条目为当日；响应 `Cache-Control: max-age=0, private, must-revalidate`，未见 ETag | `games`、`culture` | `movies`、`technology` | 官方 feed，“不止是游戏”，文章、播客和社区内容会混合；只用标题、链接、发布时间，不摄取 description 中的 HTML/正文 | `ready/http_error/timeout/parse_error/stale`；没有条件缓存 validator 时仍遵守本地刷新间隔 |

为什么没有把 Google News RSS、GDELT 或 HN 放入这五个默认来源：Google News 在当前环境能返回 100 条中文搜索结果，但中国大陆直连风险高；GDELT 已连续实测 429；HN 内容是英文科技圈且与默认生活聊天不匹配。三者可以保留为关闭状态的实验/按需 provider，但不应在五来源中任一失败时自动填入其他类别。

### 8.2 固定分类路由

来源选择必须由用户话题偏好驱动，不能“所有来源全拉再靠标题猜类别”。建议固定映射如下：

| 偏好分类 | 首选来源 | 同类兜底 | 说明 |
|---|---|---|---|
| `lifestyle` | 中新网生活、百度实时热榜 | B 站热门的生活/美食/旅行/运动分区 | 百度和 B 站是热度候选；涉及具体事实时优先使用中新网或按需搜索交叉核验 |
| `culture` | 中新网文化、机核 | B 站知识/音乐/舞蹈/国创/纪录片分区 | 文化可以包含展览、图书、演出、播客，不自动混入社会新闻 |
| `movies` | 百度电影榜、中新网文化 | B 站影视/电影分区、机核 | 百度电影榜是热度榜而非“刚上映”；模型表达时必须区分榜单热度和近期新闻 |
| `games` | 机核、B 站游戏分区 | IT之家标题明确包含游戏产品时 | 不调用不存在的百度 `game` tab，不用 HN 替代中文游戏内容 |
| `technology` | IT之家 | B 站科技/数码分区、机核明确科技条目 | 仅在用户偏好中存在或用户本轮主动提及时采集 |
| `science` | IT之家标题/分区明确为航天、基础科学或科研的条目 | B 站知识/科学科普分区 | 这五源对严肃科学的覆盖仍偏弱；不足时显示“该分类本次不足”，不要拿普通数码新闻凑数 |
| `health`、`sports` | 中新网对应 RSS | B 站对应分区仅作轻话题候选 | 健康内容保留来源与日期，并禁止诊断、处方或治疗建议 |

分类 adapter 只返回候选，统一层再做 URL/标题去重。每个候选必须保留 `sourceId/sourceName/category/title/url/publishedAt?/fetchedAt`；百度没有 `publishedAt` 时显式为 `null`，不能用抓取时间冒充发布时间。

### 8.3 与偏好数量和手动刷新的对应关系

本轮产品规则可以直接落成确定性预算：未出现在偏好设置中的分类请求数为 0；`neutral` 最终缓存 3 条；`interested` 最终缓存 6 条。这里的 3/6 是**去重、时效过滤后的最终条目数**，不是单个来源的 HTTP `max_items`。为了应对重复和不合格条目，可让 adapter 有界获取最多目标数的 2 倍候选，但不能因此把未选择的分类塞进缓存。

自动预取和“手动刷新采集信息”应共用同一调度器：

1. 按偏好分类建立刷新计划，只请求该分类的首选与必要兜底来源。
2. 首选结果经去重后已达到 3/6 时，不再请求该分类的末级兜底。
3. 手动刷新绕过本地内容 TTL，但不绕过正在进行的同源请求、最小 provider 间隔和短时失败退避；同一来源只允许一个 in-flight 请求。
4. 手动刷新结束后返回每类 `requested/collected/shortfall`，不足是正常结果，不能跨类别补齐。
5. 设置页来源状态应显示：来源名、负责分类、固定状态、上次成功时间、最近条目时间、缓存条数及刷新按钮；不要显示正文、URL、原始错误或用户对话。

### 8.4 adapter 实现约束与降级次序

- RSS 必须用 XML parser，禁用外部实体，只读取 `channel/item` 的固定字段；JSON 只读取白名单路径并限制响应体。所有 endpoint 固定在代码中，模型和网页内容不能提供 URL。
- 中新网和 IT之家优先使用条件请求；其他来源使用本地 TTL 和请求合并。没有来源公布公共调用配额，因此建议自动刷新不高于：百度/B 站 2 小时，新闻/科技/游戏 RSS 4 小时；手动刷新受至少 30 秒同源冷却限制。
- 百度、B 站接口为内部接口，字段变化概率高。解析失败时标记 `schema_changed` 并保留旧缓存，不尝试抓 HTML 页面。
- 某来源失败只在同一分类内降级。例如机核失败可用 B 站游戏候选，不能用中新网社会新闻填补游戏 6 条；IT之家失败也不能自动启用 HN。
- B 站和百度提供的是热度/兴趣信号。若候选涉及灾害、健康、金融、政策或争议事实，只能作为按需搜索的 query seed，不能直接让模型当作已确认事实陈述。

### 8.5 实测复核清单

实现后至少用以下断网/协议桩验证：RSS 200、RSS 304、JSON `code=0`、HTTP 429、超时、XML 损坏、JSON 字段缺失、旧缓存存在/不存在、两个来源返回同标题、`neutral=3`、`interested=6`、未选择分类零请求、手动连点刷新请求合并。真实大陆网络还需分别验证 DNS/TLS、首包延迟和 24 小时内的成功率；本节的单次开发环境请求不能替代这项验收。

## 9. 分类专业源与搜索兜底扩展（2026-08-09 实现记录）

第 8 节保留了五来源阶段的调研依据。本轮在“个人自用、优先内容匹配”的产品约束下，将默认 adapter 扩展为 11 个：中新网、百度、B 站、IT之家、Steam Charts、App Store 中国区游戏榜、豆瓣电影、网易云音乐、下厨房、携程景点榜，以及必应中文 RSS 分类搜索。机核编辑内容流因混有采访、论文和泛文化文章，不再参与默认采集。分类选择不再在所有来源之间平均轮询：影视→豆瓣剧情简介，电脑/手机游戏→Steam 与 App Store 交替入选，音乐→网易云，科技→IT之家，美食→下厨房，旅行→携程；专业源缺口才由同类来源和分类搜索补齐。

当前偏好预算为 `neutral=10`、`interested=15`、`not-interested=0`，全局缓存上限为 200；对话单轮注入最多 3 条，每条短文本最多 300 字、整块最多 1200 字。RSS/搜索摘要需两次有界实体解码、两轮标签清理、页面操作词移除、标题重复检测和 240 字截断。通用响应保持 2 MiB 上限；携程页面因内嵌 `__NEXT_DATA__` 实测约 2.3 MiB，单独使用 4 MiB 有界上限，不放宽其他来源。

2026-08-09 的实现复核后，默认来源为 15 个：中新网、百度、B 站、IT之家、Steam 限时免费、Steam 新游、Epic 限免、App Store 中国区新游、豆瓣电影、汽水音乐、网易云音乐、城市餐饮搜索、携程餐厅榜、携程景点榜和必应中文分类搜索。Steam 热门实现保留但不进入默认路径；下厨房、机核也不进入默认启动预取。当前项目明确是个人自用，不以商业发布为目标，因此来源授权边界暂不作为本轮实现门槛，但仍需保留固定来源、缓存、解析和隐私边界。携程餐厅榜提供餐厅名、地址、评分、人均和详情链接，城市餐饮搜索在已推断的用户/角色城市存在时优先，携程全国榜作为无城市提示的兜底。游戏保持一个用户可见的“游戏”分类，内部按新游与限免交替，缺少某类型才回填；音乐优先汽水音乐，网易云兜底。日常生活选择阶段对同一事件族（例如同一台风）最多保留两条，避免单一灾害占满缓存。缓存 schema 已从 8 提升到 9，旧菜谱缓存会自动失效。确定性测试覆盖解析、选择和降级合同；真实网络来源能否填满每个分类仍取决于当次内容、限流和页面格式，必须在设置状态和设备验收中如实显示短缺。细分查询词与候选的相关性排序列为后续优化。

地点提示只来自人格中显式的“现居/长在”表达、已解析的观众画像城市和近期用户消息中的“住在/居住在/常住/人在”表达；前端只发送最多三个规范化城市名，Rust 不保存原始人格、记忆或聊天文本。条目标题在设置页通过 Tauri opener 插件打开系统浏览器，并限制为无凭据的 HTTPS URL。该单次 smoke 只证明当前解析与兜底链路可用，不能替代持续可用率监测；来源格式变化时仍应显示短缺和固定错误状态，不能跨分类填充无关内容。
