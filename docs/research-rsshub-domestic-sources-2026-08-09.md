# RSSHub 与国内信息源：借鉴价值评估（2026-08-09）

## 结论

RSSHub 对获取中文/国内信息源**有明显帮助，但适合作为可选的自托管采集层或路由参考，不适合作为本应用直接依赖的公共服务或“搜索引擎”**。建议 clean-room 借鉴其路由目录、源站适配、缓存合并请求、代理故障转移和反爬能力标记；在本项目中新增一个显式关闭、可配置的 RSSHub adapter，把 RSSHub 输出重新规范化为现有 provider-neutral observation。不要复制 RSSHub 源码到 Tauri、不要默认请求 `rsshub.app`，也不要让 RSSHub 内容绕过现有来源/时间/大小/prompt-injection 边界。

## RSSHub 能做什么

- 官方 README 将 RSSHub 定义为把各种来源转换为 RSS 的聚合网络，并称有 5,000+ 实例、社区持续维护路由（[README](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/README.md#introduction)）。这意味着它解决的是“按站点/接口编写适配器并输出 RSS”，不是统一的新闻事实核验或全文搜索。
- 当前仓库快照（commit `dfb39a252a0eb8d26214d59aee2868849ef6ccae`）的 `lib/routes` 有 1,616 个一级路由目录；国内常见站点也有专门适配器，例如 `bilibili`（55 个文件）、`zhihu`（31）、`douban`（31）、`baidu`（10）、`weibo`（11）、`thepaper`（11）、`juejin`（14）、`sspai`（14）、`36kr`、`ithome`、`chinanews`，另有 `steam`、`epicgames`、`appstore` 等来源（[routes](https://github.com/DIYgod/RSSHub/tree/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/routes)）。覆盖面足以补充国内榜单、视频、科技、社区和文娱主题，但单个路由是否仍可用必须逐个实测。
- 路由元数据显式声明 `requireConfig`、是否需要 Puppeteer、`antiCrawler` 等特性（[types.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/types.ts#L320-L365)）。例如知乎热榜标记 `antiCrawler: true`，可选 Cookie，并直接调用 `api.zhihu.com`（[zhihu/hot.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/routes/zhihu/hot.ts)）。这类元数据可作为本项目“源风险/凭据需求”配置的输入，而不是把所有路由当作同一可靠等级。
- RSSHub 统一使用可替换的请求工具，默认对 400/408/409/425/429/5xx 重试，并在失败时可切换代理（[utils/ofetch.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/utils/ofetch.ts)）。缓存中间件按路径、格式和 limit 生成键，并用 claim 避免同一路径并发重复抓取；默认路由缓存 5 分钟（[middleware/cache.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/cache.ts)、[config.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/config.ts#L770-L825)）。这些是值得借鉴的采集工程模式。

## 国内源的现实边界

1. **反爬和登录依赖是常态。** 路由可声明 `antiCrawler`、Cookie、浏览器自动化需求；站点 API、页面结构、签名和登录态变化会使路由失效。RSSHub 的重试/代理只提高可用性，不能保证绕过验证码、WAF 或封禁。
2. **网络位置影响很大。** 中国大陆、海外出口、IPv4/IPv6、代理质量会得到不同结果；代理池还会增加账号、隐私和合规风险。国内平台对高频聚合、未授权接口和商业化再分发的限制可能随时变化。
3. **RSS 条目不是事实验证。** 路由通常只映射标题、链接、摘要和发布时间；发布时间可能缺失或由源站提供，抓取成功不代表内容真实、完整或可长期访问。RSSHub 也不替应用做去重、时效判断、敏感信息过滤和提示词注入防护。
4. **公共实例不应作为生产依赖。** RSSHub 官方站点当前明确提示 `rsshub.app` 仅供测试，并会因成本逐步限制部分阅读器，长期使用应自托管（[官方部署提示](https://docs.rsshub.app/deploy/)）。

## 维护、封禁、合规与许可证风险

- 上游项目为 **AGPL-3.0**（[LICENSE](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/LICENSE)，README 也明确标注）。不要把 RSSHub 代码、路由文件或其派生实现静态链接/打包进本项目；若运行独立 RSSHub 服务，应由使用者自行履行 AGPL 对修改版网络服务的源代码提供义务。具体分发/网络交互义务需法务确认。
- RSSHub 支持 `ACCESS_KEY` 访问控制（[middleware/access-control.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/access-control.ts)），并有反盗链模板能力（[middleware/anti-hotlink.ts](https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/anti-hotlink.ts)）。自托管时应仅监听本机/受控网络、设置访问密钥、限制路由和请求速率，不把带 Cookie 的私有订阅地址暴露给模型或日志。
- 采集需遵守各站点服务条款、robots/版权、个人信息和地区法规；尤其是登录后 feed、用户动态、评论和付费内容。应用应只保留必要的短摘要和来源链接，不做全文镜像或跨用户共享缓存。

## 与本项目 observations 的集成建议

现有实现已经规定：网页观察默认关闭；仅 allow-listed provider；查询/响应/URL/来源时间/注入文本均有上限；异常降级为空且不阻塞对话；观察是不可信数据，不能写入 persona、system、skill、Memory 或诊断（[roadmap-ai-roleplay.md](./roadmap-ai-roleplay.md#211-元元日常人设改进基线与权威方案2026-07-29)、[`src-tauri/src/api.rs`](../src-tauri/src/api.rs) 的 `/api/web-observations`、[spec-realtime-conversation-v2.md](./spec-realtime-conversation-v2.md#fresh-topic-service)）。RSSHub adapter 应服从同一合同：

1. **部署形态：** 用户自行运行的 loopback RSSHub（或管理员明确配置的 HTTPS 地址）；默认 `disabled`，不调用 `rsshub.app`。Rust 代理是唯一出口，前端不能任意拼接 RSSHub URL。
2. **路由白名单：** 只允许审核过的固定路由（例如中新网、IT之家、B 站/知乎热榜、豆瓣电影），每个路由记录 locale、类别、是否需要 Cookie/Puppeteer、刷新 TTL 和法律/内容风险。不要开放任意 URL 转发，否则会变成 SSRF/代理滥用入口。
3. **有界抓取：** 单次最多 4 条、响应体和单条摘要沿用现有上限；连接/读取 deadline、重试和并发上限小于 RSSHub 默认能力。优先读取 RSS 条目字段，清洗 HTML，保留源站 `pubDate`（若缺失再单独标记）与本机 `fetchedAt`，去重并保留 source URL。
4. **安全边界：** 对标题/摘要执行现有 observation sanitizer；明确包裹为不可执行 observation。RSSHub 的 HTML、标题和评论可能包含提示词注入、脚本或恶意链接，不能进入工具指令、Memory 写入或诊断正文。
5. **失败策略：** 将网络、429/403、鉴权、解析、路由失效分别映射为固定 provider 状态；保留未过期缓存时可返回缓存并标记 stale，绝不为了“有内容”静默编造。实时通话只在已协商的 `fresh-topic-v1` 且命中有界缓存时消费，不能在通话路径临时启动抓取。
6. **维护闭环：** 为每个白名单路由做定期 fixture/真实网络 smoke，监测空 feed、字段漂移、封禁和延迟；RSSHub 上游升级只作为人工审查信号，不能自动拉取并执行任意新路由。

## 建议借鉴清单

**值得借鉴：** 路由按站点隔离、结构化 `Route` 元数据、请求重试+代理 failover、缓存 claim 防击穿、源级配置/反爬标记、自动生成路由文档与测试思路。

**不建议直接依赖或复制：** 公共 `rsshub.app`、任意路由代理、带登录态的用户 feed、RSSHub 全量代码/路由、把 RSS 当作搜索或事实核验、把抓取正文直接塞进 prompt/Memory。优先实现少量 clean-room adapter，验证国内网络环境和合规边界后再扩大来源。

## 参考资料（均为一手来源）

- RSSHub README（定位、实例与自托管入口）：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/README.md>
- RSSHub 部署页（公共实例限制、自托管建议）：<https://docs.rsshub.app/deploy/>
- 路由元数据类型：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/types.ts>
- 缓存中间件与配置：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/cache.ts>；<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/config.ts>
- 请求重试/代理：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/utils/ofetch.ts>
- 访问控制/反盗链：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/access-control.ts>；<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/middleware/anti-hotlink.ts>
- 示例国内路由：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/routes/zhihu/hot.ts>；<https://github.com/DIYgod/RSSHub/tree/dfb39a252a0eb8d26214d59aee2868849ef6ccae/lib/routes/bilibili>
- RSSHub 许可证与安全政策：<https://github.com/DIYgod/RSSHub/blob/dfb39a252a0eb8d26214d59aee2868849ef6ccae/LICENSE>；<https://github.com/DIYgod/RSSHub/blob/master/SECURITY.md>
- 本项目角色扮演路线图：[`docs/roadmap-ai-roleplay.md`](./roadmap-ai-roleplay.md)
- 本项目实时话题规格：[`docs/spec-realtime-conversation-v2.md`](./spec-realtime-conversation-v2.md)
