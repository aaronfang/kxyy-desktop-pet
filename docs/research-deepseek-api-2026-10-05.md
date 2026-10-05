# DeepSeek API 契约核对（2026-10-05）

## 结论

- OpenAI 兼容接口当前示例使用 `https://api.deepseek.com/chat/completions`，鉴权仍为 Bearer API Key；项目无需迁移到 Responses API。
- Flash 的正式模型名已改为 `deepseek-flash`，对应 DeepSeek-V4.1-Flash。旧 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 所指模型已经下线，仅由服务端临时兼容并路由到最新 Flash，因此项目应在本地迁移旧值，不再上送旧名。
- `deepseek-v4-pro` 仍是公开模型名。
- `deepseek-flash` 原生支持图片，不再需要单独的 Vision Exp 模型名。
- Chat Completions 的思考开关仍是 `thinking: { "type": "enabled" | "disabled" }`；思考默认开启。开启思考时不应依赖 `temperature`，思考内容仍从与 `content` 同级的 `reasoning_content` 返回。

## 项目影响

- 默认和显式 Flash 请求统一发送 `deepseek-flash`。
- 旧 Flash、Vision Exp 和 `deepseek-chat` 设置兼容迁移到 `deepseek-flash`；未知值仍回退到 Flash，不原样转发。
- DeepSeek 视觉描述请求显式关闭思考，避免默认思考增加延迟并让 `temperature` 失效。
- 显式选择 Flash 的直接多模态路径继续保留，名称与设置文案改为 V4.1 Flash。
- Persona 蒸馏脚本同步使用当前 `/chat/completions` 路径并显式关闭思考。

## 官方来源

- [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：当前公开模型名、版本、图像能力、旧名兼容状态和价格。
- [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision)：`deepseek-flash` 原生图片输入与旧 Vision Exp 下线说明。
- [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)：`thinking.type`、默认开启、`reasoning_effort`、`temperature` 限制和 `reasoning_content` 响应字段。
- [创建对话补全](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)：Chat Completions 请求与响应结构。
- [V4.1 Flash 发布说明](https://api-docs.deepseek.com/zh-cn/news/news260910)：V4.1 Flash 上线及旧 Flash/Vision Exp 名称的临时兼容路由。
