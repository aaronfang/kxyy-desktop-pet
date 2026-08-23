# Ornith-1.5-9B 在 MacBook M4 48GB 与本项目中的可行性

调查日期：2026-08-22

## 结论

- **能跑，而且内存余量充足。** 官方 Hugging Face 模型卡把 Ornith-1.5-9B 描述为 9B dense 模型，BF16 权重约 19GB；官方 Ollama 模型页列出的 `ornith-1.5:9b` 下载体积约 6.6GB，256K context，支持文本和图片输入。MacBook M4 48GB 运行 Ollama 的量化版本在容量上可行，通常应保留给系统、KV cache 和上下文的余量；但“顺畅”仍取决于上下文长度、并发和 Ollama/Metal 版本。
- **速度没有可引用的官方 M4 tok/s 数字。** Ornith 官方卡片只给评测分数、模型尺寸和服务要求，没有 Apple Silicon/M4 的生成速度基准；Ollama 模型页也未公布 tok/s。因此不能把网上其他机器的数字当成保证。对本项目的短回复，建议以本机实测为准，分别记录首 token 延迟和生成 tok/s；关闭 thinking 会显著减少可见等待，但模型本身默认是 reasoning model。
- **可以作为本项目的文字模型，优先走现有 Ollama 路径。** 官方 Ollama 页面给出 `ollama run ornith-1.5:9b`；本项目的 `textProvider=local` 已通过 Ollama OpenAI-compatible `/v1/chat/completions` 调用任意 `localTextModel`，因此设置 `localTextModel=ornith-1.5:9b` 即可，无需 Rust 业务代码改动。首次使用需在 Ollama 中拉取模型（约 6.6GB）。
- **OpenAI-compatible 兼容性是有官方依据的。** Ornith 官方模型卡给出 vLLM/SGLang 的 `/v1/chat/completions` 示例；Ollama 页面给出 native `/api/chat` 示例。Ollama 的 `/v1` 兼容层由 Ollama 提供，项目当前已依赖该接口。

## 官方规格与运行路径

1. [Hugging Face：ornith-ai/Ornith-1.5-9B README](https://huggingface.co/ornith-ai/Ornith-1.5-9B) 称其为 9B dense、面向单 GPU/边缘部署的模型；Quickstart 写明 BF16 约 19GB，原生上下文上限 262,144 tokens，并列出 Transformers >=5.8.1、vLLM >=0.19.1、SGLang >=0.5.9 的服务要求。
2. [Hugging Face：Ornith-1.5-9B-GGUF](https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF) 提供 BF16、Q4_K_M、Q5_K_M、Q6_K、Q8_0 GGUF 文件，并附带视觉投影文件；这是 llama.cpp/Ollama 量化生态的直接来源。
3. [Hugging Face：Ornith-1.5-9B-MLX](https://huggingface.co/ornith-ai/Ornith-1.5-9B-MLX) 的元数据标注 `library_name: mlx`、`pipeline_tag: text-generation`，说明存在 Apple MLX 格式发布；该卡片没有 M4 速度数字。
4. [Ollama：ornith-1.5](https://ollama.com/library/ornith-1.5) 当前列出 `ornith-1.5:9b`：约 6.6GB、256K context、Text/Image，并给出 `ollama run ornith-1.5:9b` 与 native `/api/chat` 示例。

## 与本项目的接口核对

本项目 [src-tauri/src/local_text.rs](/Users/aaronfang/Documents/github/kxyy-desktop-pet/src-tauri/src/local_text.rs) 将 Ollama 视为共享系统服务，默认地址 `http://127.0.0.1:11434`，默认文字模型是 `qwen3:14b`，但设置允许填写任意 `localTextModel`。 [src-tauri/src/api.rs](/Users/aaronfang/Documents/github/kxyy-desktop-pet/src-tauri/src/api.rs) 在 `textProvider=local` 时把模型名放入 `/v1/chat/completions`，并保留 `messages`、`stream`、`temperature`、`max_tokens` 合同；本地模型还会发送 `reasoning_effort` 与 `think` 控制。因而建议：

```text
textProvider = local
localTextModel = ornith-1.5:9b
```

模型默认会产生 `<think>...</think>` 推理段（官方卡片明确说明）。本项目关闭 thinking 时会发送 `reasoning_effort=none` / `think=false`；是否完全抑制推理取决于当前 Ollama 对该模型模板的支持，需实测确认。若回复出现思考段或截断，应先在 Ollama CLI 用同一模型验证，再调整项目 thinking 与 max_tokens。

## 速度与实测建议

截至调查日，一手页面没有 M4/M4 Pro/M4 Max 的 tokens/s、首 token延迟或功耗数据；所以本文不捏造“每秒 X token”的结论。应在目标 Mac 上分别测试：

```bash
ollama run ornith-1.5:9b
```

记录短中文对话（约 100--300 输出 tokens）与长上下文两组的首 token 延迟、生成 tok/s、内存占用和是否发生 swap。Ollama 首次加载会有冷启动延迟；本项目会通过 native `/api/chat` warmup/keep-alive 尝试保持模型常驻，但这不改变模型本身的生成速度。48GB 机器不要直接把 256K context 当作默认工作集，项目本地文字路径默认上下文为 16,384 tokens，以避免 KV cache 把内存吃满。

## 适配边界

- 这是**文本模型**路径的可行替换，不等于已验证 persona 质量、中文风格或 thinking 行为与当前 `qwen3:14b` 一致。
- Ollama 页面标注支持图片，但本项目的文字模型与本地 VL 模型设置是分开的；要做看图仍应走项目现有 `localVlModel` 路由，不要仅因模型页的 Text/Image 标签就假定所有聊天路径自动支持图片。
- 官方模型卡的 vLLM/SGLang 推荐启动参数包含 reasoning/tool-call parser；本项目直接依赖 Ollama `/v1` 兼容层，工具调用不是本项目日常文字聊天的必要条件，仍应以本项目实际请求/响应字段为准。

