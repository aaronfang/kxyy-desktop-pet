# Smart-Scraper-RSS 调研（2026-08-09）

仓库：[tianxingleo/Smart-Scraper-RSS](https://github.com/tianxingleo/Smart-Scraper-RSS)

## 结论

有借鉴价值，但不建议直接作为本项目的网络信息采集依赖或子进程。它更像一个“浏览器自动化抓取 + LLM 内容审核 + RSS 发布”的独立服务；对本项目最有价值的是内容质量处理流程和平台抓取策略，不是它的 RSS 服务本身。

## 一手资料验证

GitHub API（2026-08-09）显示：MIT 许可证，默认分支 `main`，仓库约 4 stars、0 open issues，最近一次 push 为 2026-07-26。项目 README 宣称支持：

- 哔哩哔哩视频
- 小红书笔记
- 小黑盒资讯
- 酷安动态

源码目录中对应策略为 `app/scraper/strategies/bilibili.py`、`xiaohongshu.py`、`xiaoheihe.py`、`coolapk.py`。

## 它的架构

README 和源码确认的链路是：

`APScheduler -> DrissionPage/Chromium -> SQLite/SQLModel -> OpenAI-compatible LLM -> RSS 2.0`

主要组件：

- FastAPI + Uvicorn 管理 Web API 和设置页
- DrissionPage 驱动 Chromium，支持 Cookie、代理和浏览器 profile
- SQLite + SQLModel 持久化来源、原始条目和分析结果
- OpenAI-compatible API，README 推荐 DeepSeek
- LLM 输出质量分数、广告标记、风险等级、情绪、关键词和摘要
- Feedgen 生成 RSS
- APScheduler 定时刷新

## 对国内来源的实际帮助

### 哔哩哔哩

源码不只抓页面，还实现了 B 站公开接口/WBI 签名、视频详情、标签、播放数据、AI 字幕和热评补充。这部分对本项目很有参考价值，尤其适合解决“B 站候选有内容但简介不足”的问题。

但它的推荐流接口依赖 Cookie；无 Cookie 时会退回页面抓取。验证码、登录、Cookie 和浏览器自动化都使它不适合直接嵌入 Tauri Rust 主进程。

### 小红书

策略代码明确处理登录和安全限制，依赖浏览器与用户 Cookie。它可以作为生活、美食、旅行灵感来源，但自动化稳定性和授权边界风险较高，不适合作为默认启动预取来源。

### 小黑盒

当前 `xiaoheihe.py` 实际是抓取指定文章页面（标题、正文、作者、封面），不是稳定的热门游戏榜或新游榜适配器。因此它不能直接解决本项目游戏榜单问题。

### 酷安

可以提供 Android 应用和数码/软件讨论，但来源内容更偏动态/社区流，需额外做分类和广告过滤，不能直接当作游戏榜单。

## 最值得借鉴的部分

1. **平台策略隔离**：每个平台一个 strategy，统一输出 `title/content/url/author/published_at`，可映射到本项目的 `FreshTopicSource`。
2. **浏览器和 Cookie 生命周期**：Cookie 持久化、代理、重试、验证码失败后的明确状态，比盲目重试更适合国内站点。
3. **内容质量分析字段**：`ai_score`、`is_ad`、`risk_level`、`sentiment`、`keywords`、`ai_summary` 可转化为本项目候选评分和来源诊断字段。
4. **原文抓取与摘要分离**：先保留原始标题/正文，再由 LLM 生成摘要；可改善当前“标题和简介完全相同”问题。
5. **增量和去重**：项目强调 URL 去重和定时增量抓取，可借鉴到 provider pool，而不是每次从零生成缓存。

## 不建议直接引入的部分

- 不把整个 FastAPI/Chromium/SQLite 服务嵌入 Tauri；会增加安装体积、进程管理和设备资源占用。
- 不在主应用中复刻验证码识别或反检测逻辑。应将这类来源作为可选外部服务，并显示登录/失败状态。
- 不把 LLM 质量评分作为唯一入选条件。当前项目仍需要确定性的类别过滤、来源优先级、时效和隐私边界。
- 不把 RSS XML 作为内部唯一协议。当前 Rust 缓存已经有结构化 `FreshTopic`，可直接借鉴字段而不增加二次解析。

## 推荐落地方案

优先提取三个小模块，而不是引入整个项目：

1. 在 Rust `FreshTopic` 增加可选的 `qualityScore`、`isAd`、`riskLevel` 和 `keywords`，但保持诊断和对话注入的边界。
2. 为 B 站增加“详情/字幕/标签增强”适配层，先只在用户启用游戏、影视或生活类偏好时按需触发。
3. 将其“原始内容 -> 结构化摘要 -> 分类过滤”的流程作为候选质量增强阶段，使用本项目现有的 DeepSeek/Qwen 管线，不启动独立 FastAPI 服务。

## 来源

- [README.md](https://raw.githubusercontent.com/tianxingleo/Smart-Scraper-RSS/main/README.md)
- [requirements.txt](https://raw.githubusercontent.com/tianxingleo/Smart-Scraper-RSS/main/requirements.txt)
- [Bilibili scraper](https://raw.githubusercontent.com/tianxingleo/Smart-Scraper-RSS/main/app/scraper/strategies/bilibili.py)
- [Xiaoheihe scraper](https://raw.githubusercontent.com/tianxingleo/Smart-Scraper-RSS/main/app/scraper/strategies/xiaoheihe.py)
- [AI analyzer](https://raw.githubusercontent.com/tianxingleo/Smart-Scraper-RSS/main/app/ai/analyzer.py)
- [GitHub repository metadata](https://api.github.com/repos/tianxingleo/Smart-Scraper-RSS)
