# Unsloth Hugging Face 模型与当前硬件适配性（2026-08-31）

## 范围与硬件事实

本调查只使用 Hugging Face `unsloth` 组织的官方模型卡/API，以及仓库内已经记录的硬件事实；不把下载量或第三方 benchmark 当成硬件可行性证明。

- Windows：GeForce RTX 5080，16 GB VRAM，Blackwell。项目对该机器的运行时门槛是 CUDA 12.8（cu128）、PyTorch 的 `torch.cuda.get_arch_list()` 包含 `sm_120`，并通过真实 CUDA tensor smoke；不能只看 `torch.cuda.is_available()`。
- macOS：Apple M4 Pro，48 GB 统一内存。仓库现有本地文字路径使用 Ollama，默认 `qwen3:14b`，本地上下文默认 16,384 tokens；M4 的生成速度、长上下文内存峰值必须在目标机实测。
- 参考：[项目本地文字实现](../src-tauri/src/local_text.rs)、[README 本地模型说明](../README.md)、[Ornith-1.5-9B M4 调研](research-ornith-1.5-9b-mac-m4-2026-08-22.md)。

## 官方模型事实

下表的文件大小来自 Hugging Face `resolve/main` 响应的 `X-Linked-Size`（截至 2026-08-31）；这是权重文件体积，不是运行时总内存。KV cache、工作区、视觉编码器和上下文会额外占用内存。

| 模型卡 | 官方定位/能力 | 代表性量化文件 | 文件体积 | 适配判断 |
|---|---|---:|---:|---|
| [Qwen3-8B-unsloth-bnb-4bit](https://huggingface.co/unsloth/Qwen3-8B-unsloth-bnb-4bit) | Qwen3 8B，Apache-2.0；Transformers + bitsandbytes 4-bit | 两个 safetensors 分片（首片） | 首片约 4.98 GB | RTX 5080 余量最大，适合低延迟/长上下文实验；Windows 需确认 bitsandbytes 与 Blackwell/cu128 组合。M4 不应默认采用 CUDA bnb，优先 GGUF/Ollama。 |
| [Qwen3-14B-GGUF](https://huggingface.co/unsloth/Qwen3-14B-GGUF) | 14B dense；支持 thinking/non-thinking 切换、100+ 语言、角色扮演；Apache-2.0 | `Qwen3-14B-Q4_K_M.gguf` | 约 9.00 GB | **双平台主力候选**。RTX 5080 16GB 可为权重、运行时和中等上下文留出空间；M4 48GB 也有充分容量。与项目现有 `qwen3:14b` 默认方向一致，但仍需在 Ollama/llama.cpp 中实测 tok/s、首 token 和 16k context。 |
| [Qwen3-14B-GGUF（同卡）](https://huggingface.co/unsloth/Qwen3-14B-GGUF) | 同上 | `Qwen3-14B-Q8_0.gguf` | 约 15.70 GB | RTX 5080 几乎没有 KV/工作区余量，不作为本地聊天默认；M4 48GB 可离线质量对比，但需关注统一内存压力。 |
| [Qwen3-VL-4B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF) | 4B 视觉语言模型；原生 256K context（可扩展至 1M）；Apache-2.0；模型卡建议 Flash-Attention 2 以节省显存 | `Qwen3-VL-4B-Instruct-Q4_K_M.gguf` | 约 2.50 GB | **本地图片理解候选**。两平台容量都充足，适合替代“图片先生成描述”路径的实验；实际 Ollama/llama.cpp 多模态模板、视觉编码器内存和速度需要单独 smoke。 |
| [Qwen3-30B-A3B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF) | MoE，总 30.5B、每 token 激活约 3.3B；仅 non-thinking；原生 262,144 context；Apache-2.0 | `...Q4_K_M.gguf` | 约 18.56 GB | RTX 5080 16GB **装不下完整 Q4 权重**，除非 CPU/统一内存 offload（未由项目验证，且会增加延迟），不应列为 Windows 实时默认。M4 48GB 容量上可容纳权重+上下文，适合质量/长上下文离线试验；生成速度和 swap 仍未知。 |
| [Qwen3-Coder-30B-A3B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF) | MoE 30.5B/3.3B active；面向 agentic coding；原生 262K context；Apache-2.0 | `...Q4_K_M.gguf` | 约 18.56 GB（同级） | 不是桌宠日常聊天的首选；M4 可作为代码/仓库分析离线模型，RTX 5080 仍受 16GB 限制。 |

补充的官方 GGUF 卡（同样只按权重体积做容量筛选）：

| 模型卡 | Q4_K_M / 特殊量化文件 | 适配判断 |
|---|---:|---|
| [Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) | 约 5.68 GB（另有约 0.92 GB `mmproj-F16`） | RTX 5080 和 M4 都有容量余量；多模态运行需把视觉投影器计入内存，并验证 Ollama/llama.cpp 模板。 |
| [Qwen3.5-4B-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) | 约 2.74 GB（`mmproj-F16` 约 0.67 GB） | RTX 5080 的低延迟/低内存档；质量需用项目中文角色语料实测。 |
| [Gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) / [E4B](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF) | E2B 约 3.11 GB；E4B 约 4.98 GB（各含约 0.99 GB `mmproj-F16`） | 两平台容量友好，适合多模态试验；需确认 Gemma 许可条款与本地运行时支持。 |
| [Gemma-4-12B-it-qat-GGUF](https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF) | QAT UD-Q4_K_XL 约 6.72 GB | RTX 5080 容量上可行的 12B 视觉/文本候选；模型卡称 QAT 在低内存下保持接近 BF16 质量，但项目仍需中文对话和上下文实测。 |
| [gpt-oss-20b-GGUF](https://huggingface.co/unsloth/gpt-oss-20b-GGUF) | MXFP4 约 11.62 GB（Q8 约 12.11 GB） | 官方卡明确称 20B 可在 16GB memory 内运行；对 RTX 5080 仍须给 KV cache/工作区留余量，且需验证 Ollama 对 MXFP4 与模型模板的支持。M4 48GB 可做离线试验。 |

组织中的 Qwen3.8-27B / Qwen3.6-35B-A3B NVFP4 safetensors 文件约 22--24GB，超过 RTX 5080 单卡显存；NVFP4/CUDA 路径也不适用于 M4 的 Metal 后端，因此不列入当前候选。

## 结论（按使用场景）

1. **跨 Windows RTX 5080 与 M4 Pro 48GB 的默认本地聊天**：继续以 Qwen3 14B 的 Q4 GGUF 档为基线（项目已使用 `qwen3:14b`）。它的官方模型卡明确支持角色扮演、多轮对话和 thinking/non-thinking 切换；9.00GB 权重体积给 RTX 5080 留出了比 Q8 更现实的运行余量。
2. **RTX 5080 低延迟/并发优先**：Qwen3 8B 4-bit 是更保守的实验档；应通过 Ollama/Transformers 实测，而不是假设 bnb 4-bit 在 Blackwell 上天然可用。若使用 GGUF，选择同系列 Qwen3 8B GGUF 并记录实际文件与上下文设置。
3. **本地图片理解**：Qwen3-VL 4B Q4_K_M、Qwen3.5-4B/9B GGUF、Gemma 4 E2B/E4B 都是容量宽松的视觉候选。它们不能直接证明现有 Ollama VL 适配完成，必须验证模板、图片输入、峰值内存和错误恢复。
4. **M4 质量/长上下文离线试验**：Qwen3-30B-A3B-Instruct-2507 Q4_K_M 在容量上可尝试，但它只支持 non-thinking；不要把“3.3B active”误当成 3.3B 权重内存，完整量化文件仍约 18.6GB。RTX 5080 不纳入默认候选。
5. **可选 20B 档**：gpt-oss-20b MXFP4（约 11.6GB）在官方卡上标注可在 16GB memory 运行，但这不是 RTX 5080 实测，也不代表在本项目上下文/并行 TTS 下有余量；先做隔离 smoke。
6. **不建议直接采用**：BF16/Q8 大档在 16GB 显存上没有足够运行余量；30B 级模型在 RTX 5080 上需要未经验证的 offload。Unsloth 页面里的“3x faster/70% less memory”等是其训练 notebook 对比，不是本项目推理 SLA 或目标硬件实测。

## 验收要求

对任何要进入设置页或默认配置的模型，分别在 Windows RTX 5080 与 M4 Pro 上记录：冷/热首 token 延迟、生成 tok/s、峰值显存/统一内存、16,384 token 上下文是否 swap/OOM、中文角色扮演样例质量、取消/重试行为，以及与本地 TTS/ASR 并行时的资源竞争。Windows 还必须先通过 cu128 + `sm_120` + 真实 CUDA kernel smoke；不能用 HF 文件大小或模型卡的云端 benchmark 代替。

## 一手来源

- [Unsloth Hugging Face 组织模型列表/API](https://huggingface.co/api/models?author=unsloth)
- [Unsloth Qwen3 collection](https://huggingface.co/collections/unsloth/qwen3-680edabfb790c8c34a242f95)
- [Unsloth Qwen3 运行指南](https://docs.unsloth.ai/basics/qwen3-how-to-run-and-fine-tune)
- [Unsloth Dynamic GGUF 说明](https://docs.unsloth.ai/basics/unsloth-dynamic-v2.0-gguf)
- [Qwen3-VL Unsloth 指南](https://docs.unsloth.ai/models/qwen3-vl-run-and-fine-tune)
- [Qwen3-2507 官方说明](https://qwenlm.github.io/blog/qwen3/)
- [Qwen3-Coder 官方说明](https://qwenlm.github.io/blog/qwen3-coder/)
