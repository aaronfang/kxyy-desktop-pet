# Laya 项目调查（2026-09-22）

## 结论摘要

`NandhaKishorM/laya` 是一个 Python/PyTorch 的非自回归文本判别运行时，不是聊天生成模型、TTS、ASR 或 Agent 编排框架。它把一个状态（字符串、JSON、邮件、工单等）和一组“类型化问题”送入一次编码器前向，返回结构化决策：

- `choice`：从有限标签中选一个并返回概率/置信度；
- `score`：在有序标准上返回期望分数和分布；
- `noul`：二元事实/风险的概率（上游 API 使用的固定类型名）。

仓库在调查时的 `main` HEAD 是 `573e5b62696ba441230cd6be71d593331b5d23af`（release 0.3.5，2026-09-21）。上游称单次约 33 ms，但该数字是其 T4 基准，不能直接外推到桌面端 CPU/GPU。

## 证据与实现方式

来源：

- 上游 README（功能、模型表、示例、基准）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/README.md>
- `laya/agent.py`（下载、加载、单次前向、输出结构）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/laya/agent.py>
- `laya/common.py`（`choice`/`score`/`noul` 的张量和序列化逻辑）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/laya/common.py>
- `laya/router.py`（按脚本/语言选择 checkpoint、LRU 生命周期）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/laya/router.py>
- `laya/shortlist.py`（可选的向量粗筛后再做一次决策）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/laya/shortlist.py>
- `pyproject.toml` 与 `LICENSE`（Python 包元数据和 Apache-2.0 源码许可证）：<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/pyproject.toml>、<https://github.com/NandhaKishorM/laya/blob/573e5b62696ba441230cd6be71d593331b5d23af/LICENSE>

运行时首次加载远程模型时调用 `huggingface_hub.snapshot_download`，只允许下载配置、权重、tokenizer 和 encoder 文件；也支持本地模型路径。代码没有发现把输入发送到第三方推理 API 的逻辑。模型权重本身的许可证、训练数据来源和再分发条件不能仅凭 GitHub 的 Apache-2.0 代码许可证推断，打包进 Tauri 安装包前必须单独核实模型卡与权重文件许可。

仓库包含三个 checkpoint：

| checkpoint | README 声称的编码器/规模 | 预期用途 |
| --- | --- | --- |
| `laya` | ModernBERT-large，约 421M 参数，512 token | 英文 |
| `laya-multilingual` | mmBERT-base，约 322M 参数，1024 token | 100+ 语言 |
| `laya-typed-decisions` | ModernBERT-large，约 421M 参数，1024 token | 四类固定合成 typed-decision 工作流 |

`Router` 通过脚本/语言分析选择英文或 multilingual checkpoint；typed-decisions 默认不会自动选，除非显式启用任务检测。`preload=True` 会把多个模型常驻内存，`max_loaded=1` 则会在语言切换时驱逐并重新加载，代码注释也承认这会带来秒级冷加载。

## 对当前桌宠项目的潜在利用方式

### 1. 本地“请求分流器”（最有价值、风险最低）

在 `src-tauri/src/api.rs` 的本地代理或现有 `src-tauri/src/local_text.rs` Ollama 调用前，使用 Laya 对用户输入做固定集合分类：`chitchat`、`factual_lookup`、`creative_writing`、`data_analysis`、`needs_tools`、`is_sensitive` 等。结果只决定选择已有路径（DeepSeek、Ollama、fresh-topic、拒绝/确认），不生成文本。

收益：降低不必要的模型调用、让工具/联网意图进入现有 allow-list、为 UI 解释“为什么走本地/联网”提供结构化信号。它必须是建议器，不得绕过当前 `fresh_topics` 的显式开关、`api.rs` 的 provider allow-list 或 Memory 访问边界。

### 2. 输入安全和提示注入预筛

上游提供 `guard_questions()`，可以在把用户消息拼入 `system_role`、工具参数或 fresh-topic 查询前，产生固定的 `jailbreak`/`prompt injection`/`leak` 类概率。高风险结果可以触发现有的“不调用工具/要求确认/降级到普通对话”策略。

这不能取代现有边界：概率模型会误判，用户文本仍是不可信输入，且分类结果不应写入 persona、Memory、诊断或发送给外部 provider。不得把一个低概率结果当作安全保证。

### 3. 记忆写入前的轻量门控

可以在 `memory.rs` 的候选事实/episode/commitment 进入异步 consolidation 前，用 `noul` 判断“是否是稳定事实/是否包含敏感内容/是否需要人工确认”，用 `score` 排优先级。

但当前 Memory v3 明确要求 learned memory 不修改 persona/system/skill 规则。Laya 只能产生临时的结构化候选元数据，不能直接决定写入、删除或覆盖记忆；最终仍应走现有 schema、敏感信息规则、来源和用户可见编辑流程。

### 4. 实时语音的“会话控制提示”（不参与音频闭环）

在 `src/ai/realtime.js` 的文本控制面，可以分类用户话语是 `pause`、`redirect`、`resume`、`acknowledge` 等。但当前本地/CosyVoice 已有 mirrored fixed-rule classifiers，并且要求 RMS/VAD/ASR 与播放时序保持确定性。Laya 不应进入麦克风、VAD、候选确认、barge-in、TTS admission 或 playback Worklet；最多在最终 ASR 文本之后做旁路分析，并且不能改变既有固定规则的安全结论。

### 5. 主题/推荐候选粗筛

`shortlist.py` 可以用 embedding 先从大量候选中选前 K，再调用一次 typed decision。这对未来 Memory Graph 或 fresh-topic 的候选排序有实验价值，但当前项目的 fresh-topic 设计要求固定来源、缓存、冷却和显式参与模式；不能以“分类相关”冒充详细 query-to-item relevance，也不能把外部观察写入 Memory。

## 不建议的引入方式

- 不要用 Laya 替换 DeepSeek/Ollama：它不生成回复，不具备 persona、记忆和工具编排能力。
- 不要把 322M/421M 权重直接随 macOS/Windows Tauri 安装包捆绑：安装体积、冷启动、RAM/VRAM、模型许可和更新机制都不符合当前资源策略。
- 不要让 Laya 直接接触 API key、PCM、原始麦克风流、完整诊断或设备信息；它只需要经截断和字段白名单处理的文本/结构化状态。
- 不要把 Laya 的“confidence”当作可证明的安全阈值。README 的高分基准包含其训练分布或合成工作流，README 也明确指出英文 checkpoint 在非英文输入上会高置信错误。
- 不要让语言 Router 的自动切换进入实时语音线程；模型驱逐会造成秒级停顿，且实时协议要求有界队列和固定时序。

## 主要风险清单

1. **资源与延迟**：三个 checkpoint 总参数量约 1.16B；CPU 桌面端首次加载可能是秒级甚至更久，常驻会明显增加内存。当前项目的本地 Python 生命周期只为语音后端设计，不能无条件复用。
2. **模型/代码许可不等价**：仓库源码 Apache-2.0 不代表 Hugging Face 权重、底层 encoder、tokenizer 或训练数据都可按同一条款再分发。引入前需固定 commit、下载文件 hash、模型卡许可证和 NOTICE。
3. **领域偏移**：上游 benchmark 是公开分类任务和其 typed synthetic workflows；中文桌宠口语、方言、角色扮演、ASR 噪声与 Memory 文本需要本地标注集和混淆矩阵验证。
4. **过度自动化**：错误的 `needs_tools`、`is_sensitive` 或 jailbreak 判断可能造成漏拦截、拒答或不必要联网。必须保留现有 fail-closed 和用户确认路径。
5. **供应链/网络**：首次 `snapshot_download` 会访问 Hugging Face。桌面端不应在正常聊天路径隐式联网下载；应由显式设置动作完成，校验 allow-list/hash，失败时保持当前路径可用。
6. **隐私**：即使推理本地，输入仍可能含用户私密对话。需要字段白名单、长度上限、诊断脱敏和不落盘策略，与当前 Memory/diagnostics 约束一致。

## 推荐的验证顺序

1. 先不引入依赖，做一个独立离线 Python 原型，只加载本地固定权重，输入使用脱敏、人工标注的中英文桌宠样本。
2. 测量冷启动、常驻 RAM、CPU/GPU 推理延迟、并发行为和进程异常退出；至少覆盖 macOS 和 Windows 目标硬件。
3. 只验证一个窄接口，例如 `classify_chat_route(text) -> {route, confidence, model}`，默认旁路观测，不改变产品行为。
4. 对误判、长文本、注入样本、ASR 噪声、中文/英文混合和模型不可用做确定性测试；通过后再接入本地代理的 fail-open/fail-closed 决策。
5. 在任何打包前，完成权重许可证、NOTICE、固定文件 hash、模型缓存位置、卸载/升级和离线回退审查。

## 最终建议

当前阶段不建议把完整 Laya 作为产品依赖直接合入主线。它作为“本地结构化意图/安全预筛”的研究候选有价值，优先级高于把它用于实时语音或 persona 生成，但应先以可选、离线、旁路实验验证中文桌宠数据上的收益。若验证通过，最小生产形态应是独立的本地 Python helper 或受控 Rust 子进程，使用固定的单一 multilingual checkpoint、明确的超时/内存上限、模型不可用时回退到现有逻辑，并保持所有现有联网、Memory、实时音频和诊断边界不变。
