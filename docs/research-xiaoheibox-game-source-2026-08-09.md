# 小黑盒游戏来源调研（2026-08-09）

## 结论

小黑盒适合作为中文游戏元数据和价格/标签补充来源，暂不建议直接替代 Steam/Epic/App Store 的榜单来源。当前公开网页和前端代码中确认到的是游戏搜索、游戏信息和 Wiki/赛事接口，没有确认到一个无需登录、稳定、可长期依赖的热门榜、新游榜或限免榜接口。

## 已验证的一手证据

### 官网

- 官网：[https://www.xiaoheihe.cn/](https://www.xiaoheihe.cn/)，2026-08-09 返回 HTTP 200，页面标题为“小黑盒 - 高能玩家聚集地”。
- 官网前端资源由 `imgheybox.max-c.com/heybox_website/1.7.188/` 提供，当前版本可正常下载。

### 前端公开接口清单

官网 `app.adaebfbe17a193253655.js` 明确引用了以下游戏接口：

- `GET/POST /game/search/`
- `GET/POST /game/get_game_infos/`
- `/game/match/leagues`
- `/game/match/batch_match_data`
- `/game/match/league/list/data`
- `/game/match/match/list/data`
- `/game/match/game/list/data`
- `/wiki/search`、`/wiki/get_wiki_infos`

前端默认 API host 是 `https://api.xiaoheihe.cn`，请求还会附带时间戳、签名和 Web 客户端参数。

### 游戏搜索响应

实测：

```text
GET https://api.xiaoheihe.cn/game/search/?q=steam
HTTP 200
```

返回 `result.games`，字段包括：

- `appid` / `steam_appid`
- `name`
- `game_type`、`platforms`
- `release_date` / `release_date_desc`
- `follow_num`
- `score` / `score_desc`
- `genres`、`core_tags`、`external_tags`
- `is_free`
- `price.current`、`price.discount`、`price.deadline_timestamp`
- Steam 背景图、头像和商店 capsule 图片

这说明小黑盒很适合做“中文标签、评分、关注人数、价格、折扣截止时间、平台”的补充信息。例如返回的 PC 游戏条目同时带有 `appid`、中文玩法标签、评分/暂无评分、价格和发行日期。

## 质量和局限

1. 搜索接口不是榜单接口。`q=steam` 返回的是相关游戏搜索结果，混入 Steam App、Steam Link、工具、Demo 和旧游戏，不能直接当作热门榜或新游榜。
2. 搜索响应通常没有可直接用于对话的自然语言简介，主要是标签、价格和发行信息；详情接口 `game/get_game_infos/` 在不带完整签名参数时返回失败，详情字段需要进一步确认签名和请求参数。
3. `is_free=true` 表示当前免费或免费应用，不等价于“限时免费”。限免必须结合价格截止时间和历史价格语义判断，不能只用 `is_free`。
4. 接口请求使用前端签名参数、时间戳和客户端参数。直接在 Rust 中硬编码签名算法会增加维护和合规风险，也可能随版本变化失效。
5. 当前没有确认到公开、稳定、无需登录的“小黑盒热门榜/新游榜/限免榜”端点。赛事接口是比赛数据，不是通用游戏榜单。

## 与当前来源的对比

| 需求 | 当前来源 | 小黑盒适配度 |
|---|---|---|
| 电脑游戏热门榜 | Steam Charts | 小黑盒暂未确认稳定榜单接口 |
| 电脑游戏新游 | Steam 新游搜索 | 小黑盒可按 `release_date` 补充，但需要排序和去重逻辑 |
| 限时免费 | Epic/Steam 限免 | 小黑盒有价格截止字段，但不能仅凭搜索结果证明限免 |
| 中文简介 | Steam `short_description` | 小黑盒搜索结果以标签为主，简介不足 |
| 评分/关注度/价格 | Steam/Epic 不完整 | 小黑盒明显有价值 |
| 游戏分类 | Steam genres | 小黑盒中文 `core_tags`/`external_tags` 更适合中文对话 |

## 建议

当前不直接把小黑盒作为“榜单主来源”。更稳妥的接入顺序是：

1. 先作为 Steam 游戏条目的中文增强源：用 `appid` 关联，补充中文标签、关注人数、评分和价格截止时间。
2. 仅当能确认稳定的排序参数和签名请求后，再新增“小黑盒关注度/热门”内部来源类型。
3. 不把 `is_free` 直接解释为限时免费；必须同时满足价格截止时间、折扣字段和明确的限免语义。
4. 若需要高质量简介，继续以 Steam/Epic/官方商店描述为主，小黑盒作为中文标签和用户热度补充。

## 原始来源

- [小黑盒官网](https://www.xiaoheihe.cn/)
- [小黑盒公开 API host](https://api.xiaoheihe.cn/)
- [游戏搜索接口](https://api.xiaoheihe.cn/game/search/?q=steam)
- 官网当前前端 bundle：`https://imgheybox.max-c.com/heybox_website/1.7.188/app.adaebfbe17a193253655.js`
