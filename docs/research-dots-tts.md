# dots.tts 接入调研（2026-08-13）

## 结论

**技术上可接，适合作为独立的本地 CUDA 实验后端；现阶段不适合替换 Qwen3-TTS 成为跨平台默认，也不应改动火山端到端链路。**

dots.tts 的官方身份是 [`studio-dots-ai/dots.tts`](https://github.com/studio-dots-ai/dots.tts/tree/46b6996f78daf68390c616ccbbffe388589f1420)（旧 `rednote-hilab/dots.tts` 地址现跳转到这里），不是名称相似的第三方移植；官方模型集合是 [`dots-studio/dotstts`](https://huggingface.co/collections/dots-studio/dotstts)，技术报告是 [arXiv:2606.07080v2](https://arxiv.org/abs/2606.07080v2)。它是 Apache-2.0 的约 2.198B 全连续自回归 TTS，原生 48 kHz，支持“参考音 + 精确文案”的 continuation voice cloning、普通流式 PCM，以及专用 `dots.tts-mf-2steps-stts` 的文本 token / 音频双流式。模型接口与本项目的参考音资产、句级 TTS 管线和 `provider-pcm-v1` 基本同形，接入可复用现有本地服务边界。

真正的阻力在运行时而非协议：官方 Python runtime 只选择 CUDA 或 CPU；无 CUDA 时还会拒绝默认 bf16，并没有 MPS 路径。官方包虽在 PyPI metadata 中标注 macOS，但这只证明包级兼容，不证明 Apple Silicon 可实时推理。官方优化数据也只来自单张 H800/H100，未覆盖 Windows RTX 5080、Apple Silicon 或 CPU。因此第一阶段应只做 Windows/Linux CUDA 离线 A/B，不进入安装器和设置页；macOS 继续使用已验证的 Qwen MLX，不能以 README 列出的 community MLX port 代替官方支持结论。

> 2026-08-16 更新：Higgs Audio v3 实验后端已因实时延迟、连续性和许可边界退出产品路径。下表保留其历史实测数据，只作为候选比较基线。

## 决策矩阵

| 方案 | 许可 / 分发 | 元元音色 | 实时能力 | 本项目平台成熟度 | 主要优势 | 主要短板 | 当前建议 |
|---|---|---|---|---|---|---|---|
| **dots.tts MF / STTS 2B** | Apache-2.0 | 官方 continuation clone 需要参考音 + 精确文案；SOAR 侧重最高相似度，MF/STTS 换延迟 | 官方 `generate_stream()`；STTS 可逐 token 输入并产出音频 | 官方 runtime：CUDA/CPU；Windows/Linux 目标机未实测，macOS 无官方 MPS 路径 | 清晰许可、48 kHz、官方真流式和双流式、公开中文/音色指标强 | 约 4.80 GiB 核心权重；官方优化峰值约 5.3--6.3 GB（MF，长度相关）；目标设备未知 | **P0 CUDA A/B；胜出后 P1 可选后端** |
| **Qwen3-TTS Base（当前默认本地）** | Apache-2.0 | 3 秒克隆；项目已有 5 个参考 preset 和跨平台适配 | 项目 macOS MLX / Windows faster runtime 可协商 PCM；官方 PyTorch fallback 整句 | **当前最成熟**：Apple Silicon、Windows CUDA、Linux fallback 已有生命周期和测试 | 现有默认、安装/热加载/取消均已打通；0.6B/1.7B 资源梯度更灵活 | Base 无官方 instruction；Windows 真流式依赖第三方 faster runtime | **保持默认与回退基线** |
| **CosyVoice（当前 DashScope 云桥）** | 云服务条款与计费，不分发模型 | 已登记云端克隆音色 | 项目已接官方 PCM 流式，instruction + rate | **成熟但依赖网络、Key 和服务可用性** | 无本地 GPU负担，已有情绪指令，更新由供应方托管 | 隐私/网络/计费/供应商依赖；离线不可用 | **保留云端表现力基准** |
| **火山 TTS / 端到端实时** | 云服务条款与计费 | voice_id；实时通话由供应商端到端模型控制 | TTS 云合成；通话是独立端到端协议 | **现有稳定云路径** | 无本地模型负担；端到端通话不需本地 LLM+ASR+TTS 串联 | Key、网络、计费；主动带聊和可听历史能力不与本地协议等价 | **不因 dots.tts 改动** |
| **VoxCPM2（当前实验）** | 代码与官方模型卡均标注 Apache-2.0 | Ultimate Cloning；项目已有固定 seed 和 24 kHz adapter | 官方 `generate_streaming()`；项目已接本地协议 | macOS / Windows 实验路径已存在 | 中文零样本能力强，现有 adapter 已可直接 A/B | 约 8 GB 官方显存口径，仍需实机稳定性门槛 | **与 dots.tts 同组 A/B** |
| **Higgs Audio v3 4B（已退役实验）** | 非商业研究许可，阻断发行 | 项目实测音色较稳，但部分情绪 token 会换人 | 历史 MLX 实验使用内部钩子滚动解码；非官方 provider-native stream | 仅 Apple Silicon 实验，实测 RTF 中位约 1.29 | 丰富 emotion / style / prosody 控制 | 许可阻断、4B 更重、项目实测慢于 Qwen，情绪会影响身份 | **已退出产品路径，仅保留历史研究** |

表中 Qwen、VoxCPM 的“项目成熟度”和 Higgs 的历史实验结论来自当前仓库实现与既有调研，而非 dots.tts 供应方结论：[`voice_service.rs`](../src-tauri/src/voice_service.rs)、[`research-local-voice-cloning-2026-07-31.md`](./research-local-voice-cloning-2026-07-31.md)、[`research-higgs-tts-3-4b-macos-2026-08-10.md`](./research-higgs-tts-3-4b-macos-2026-08-10.md)。

## 1. 已核实的上游事实

### 1.1 模型、架构和许可

- 官方仓库在本次调研时为 commit [`46b6996`](https://github.com/studio-dots-ai/dots.tts/tree/46b6996f78daf68390c616ccbbffe388589f1420)，PyPI package version 为 `0.3.1`。代码、模型卡和权重均声明 Apache-2.0；仓库许可证文本是标准 Apache License 2.0。[`pyproject.toml`](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/pyproject.toml#L5-L35)；[`LICENSE`](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/LICENSE)；[STTS 模型卡](https://huggingface.co/dots-studio/dots.tts-mf-2steps-stts/blob/9e7be6817ceda3fd6474af4d089ca6227918ccec/README.md)
- 模型约 2B 参数（HF API 给出的精确口径为 **2,198,091,778**），使用 48 kHz AudioVAE；骨干由 semantic encoder、Qwen2.5-1.5B-Base 初始化的 LLM、AR flow-matching DiT acoustic head 和 CAM++ speaker x-vector 组成，不使用离散 codec token。[HF API](https://huggingface.co/api/models/dots-studio/dots.tts-mf-2steps-stts)；[官方架构说明](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#-architecture)；[技术报告架构](https://arxiv.org/html/2606.07080v2#S2)
- STTS artifact 的三个主要权重文件为 `model.safetensors` 4,396,289,228 B、`vocoder.safetensors` 723,585,584 B、`speaker_encoder.safetensors` 29,150,484 B，合计约 **5.15 GB / 4.80 GiB**，不含 Python、PyTorch 和缓存。其 `config.json` 固定为 two-step sCM、48 kHz、`initial_lookahead=3` 的 buffered-ratio interleave。[模型配置](https://huggingface.co/dots-studio/dots.tts-mf-2steps-stts/blob/9e7be6817ceda3fd6474af4d089ca6227918ccec/config.json)；[文件清单](https://huggingface.co/api/models/dots-studio/dots.tts-mf-2steps-stts)

### 1.2 语言、克隆和表现力

- 官方 API 支持参考音 + 文案的 continuation cloning（README 标注为推荐、相似度最好）和仅参考音的 x-vector cloning；官方建议参考音约 10 秒以内，且 prompt transcript 必须和实际语音严格匹配。[CLI / Python API](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#cli)；[Usage Tips](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#-usage-tips)
- 模型可显式传 `ZH`、`EN`、`Cantonese` 等语言标签或自动检测；官方给出 24 语言 benchmark。中文高资源集合表现强，但粤语、阿拉伯语等长尾语言 WER 明显较高，不能把“24 语言 benchmark”解释成各语言同等成熟。[多语言表](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#minimax-multilingual-24-languages)
- 官方 Seed-TTS-Eval（约 3 秒参考音）中，SOAR 的 zh/en/zh-hard WER 为 0.94/1.30/6.60，SIM 为 81.0/77.1/79.5；同表 Qwen3-TTS 为 1.22/1.23/6.76 和 77.0/71.7/74.8，CosyVoice 3 为 1.12/2.22/5.83 和 78.1/72.0/75.8，VoxCPM2 为 0.97/1.84/8.13 和 79.5/75.3/75.3。[官方 Seed-TTS-Eval 表](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#seed-tts-eval)
- **边界：**上述数字由 dots.tts 团队按其评测设置发布，只能作为候选筛选证据，不能替代元元参考音的同机 A/B。普通 TTS 的公开 `generate()` / `generate_stream()` 没有像 CosyVoice instruction 或 Higgs control token 那样的稳定、文档化情绪控制参数。独立 `dots.tts.edit` 支持 `<emo>` / rate / pitch 等事后编辑，但那是另一 checkpoint 和二次生成流程，不适合直接映射当前实时 `SpeechStyle`。

### 1.3 流式和延迟

- `DotsTtsRuntime.generate_stream()` 在模型生成过程中逐个 yield `torch.Tensor` 音频块；不是把完成 WAV 事后切块。[官方 API](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/src/dots_tts/runtime.py#L687-L799)
- `DotsTtsRuntimeDoubleStreaming` 接受上游 LLM 的单个 text token，达到 artifact cadence 后返回音频块，`finish_text()` 再排空尾部。专用模型是 `dots.tts-mf-2steps-stts`。[官方 double-streaming API](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/src/dots_tts/runtime_double_streaming.py#L137-L339)
- 官方 `--optimize` 普通流式 benchmark 使用单张 H800、bf16、预热后请求。MF voice-cloning 的 first chunk p50/p90 为 **204/381 ms**，RTF p50 0.15，峰值分配约 5.74 GB；短 bucket 约 5.30 GB，最长公开 bucket 约 6.29 GB。compile 预热在 H800 约 3 分钟。[Efficiency](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#-efficiency)
- **未知：**官方没有发布 STTS checkpoint 的 first-chunk/RTF/显存表，也没有 RTX 5080、Windows、Apple Silicon 或 CPU 的实时数据。论文所称适合 realtime deployment 也来自 H800 服务实验，不能外推为普通桌面 SLA。SGLang Omni 可流式返回 48 kHz PCM，但当前服务端 STTS 请求在开始时仍需完整文本或已收集 token ids；WebSocket 收文本后按句/子句另起 TTS 请求，并不等于 Python runtime 的 same-request token/audio 双流式。[官方 SGLang Omni 说明](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#sglang-omni-usage)

### 1.4 硬件、依赖和系统支持

- 官方要求 Python `>=3.10,<3.13`，核心依赖含 torch/torchaudio `>=2.8.0`、transformers `>=4.57.0`、librosa、soundfile、WeTextProcessing；复现 constraints 固定 torch/torchaudio 2.8.0 和 transformers 4.57.0。[`pyproject.toml`](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/pyproject.toml#L37-L56)；[`constraints/recommended.txt`](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/constraints/recommended.txt)
- 官方 runtime 的设备选择只有 `cuda` 或 `cpu`；无 CUDA 时把 torch thread 固定为 1，且 bf16/fp16 会直接报错，必须显式 float32。代码没有选择 `mps`。[runtime device selection](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/src/dots_tts/runtime.py#L58-L109)
- package classifier 列 Linux 和 macOS，但没有 Windows classifier；这不是“Windows 不可安装”的证据，也不是“Windows 已支持”的证据。Windows + cu128/RTX 5080 只能视为待 smoke 的合理候选，因为依赖版本与项目当前 Qwen CUDA 基线接近。
- 官方 README 把 MLX 和 Swift MLX 放在 **Community Projects**，并非官方 runtime。它们可以作为后续 Mac 探索线索，但首轮产品接入不应依赖未单独审计的第三方代码和权重转换。[Community Projects](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#-community-projects)

### 1.5 安全限制

- 官方明确要求只在授权和同意下使用高保真声音克隆，禁止冒充、诈骗和虚假信息，并建议下游实施参考音同意策略、合成语音检测、水印和 AI 音频披露。[Risks and Limitations](https://github.com/studio-dots-ai/dots.tts/blob/46b6996f78daf68390c616ccbbffe388589f1420/README.md#%EF%B8%8F-risks-and-limitations)
- **未知：**仓库没有给出内建水印 API、同意验证机制或现成检测器。本项目若接入，不能把 README 的建议描述成模型已经自动执行；参考音权利、用户提示、缓存删除和输出披露仍由产品负责。

## 2. 与当前架构的适配度

### 高适配部分

1. **参考资产同形。** 项目已有 allow-list 的 `ref.wav/ref.txt` 和显式 `localRefWav/localRefText`；可直接映射到 `prompt_audio_path/prompt_text`。应优先 continuation cloning，不用质量较低的 x-vector-only 模式。
2. **本地服务边界同形。** 新建 `server_dots.py` 后可复用 `common.run()`、本地 WS+HTTP 双端口、health secret、ASR/VAD、Memory/时间/主动带聊能力，以及现有 admission / generation CancelScope。
3. **PCM 真流式同形。** dots 输出 48 kHz float tensor；adapter 可有限状态重采样为项目固定 24 kHz PCM16LE，再按最多 80 ms / 1,920 sample 写入既有 `KXAU` envelope。必须在重采样后校验有限数、幅度、偶数字节、60 秒和 750 chunk 上限。
4. **取消语义可实现。** 普通 `generate_stream()` 是 Python generator；adapter 可在每次 `next()` 返回、重采样和 sender 边界检查 CancelScope，并在取消后 `close()` generator。和所有 blocking provider 一样，正在执行的单个 `next()` 不能强杀，所以仍需 admission=1、禁止 next prefetch 和有界 drain。

### 中/低适配部分

1. **采样率不一致。** 直接把 48 kHz PCM 标成 24 kHz 会导致速度/音高错误；改变前端协议到 48 kHz 又会扩大 Worklet、ring、managed header 和回归面。首版应在 Python 服务端高质量降采样，保持所有 JS/Rust 常量不变。
2. **当前 LLM SSE 与 STTS token API 不同形。** 项目现在由 `StableSentenceBuffer` 从文字 SSE 聚合至少 30 Unicode 字符后提交 TTS；上游返回的是字符串 delta，不保证与 dots tokenizer token 边界相同。直接启用 STTS 需要在同一 Python generation 内增量 tokenize，处理 BPE 尾部回滚、EOS、取消、重连和 audible-history 句段边界，不能把字符串 delta 当 token id。
3. **可听历史以句段完成为准。** 双流式即使跨越上游 LLM 句界，也必须保留 `generation + segmentId`、播放完成 receipt 和 candidate snapshot 的语义。不能因 text token/audio 交织而把“已生成文本”当成“已听见文本”。
4. **情绪映射较弱。** dots 普通 TTS 没有已文档化的每句 instruction；相对 CosyVoice/Higgs，不适合承担近期统一 `SpeechStyle` 的主要实验。可先用文本、标点和 seed 表达自然韵律，禁止把内部 template 或 edit tags 未经 A/B 暴露为产品能力。
5. **后台常驻成本更高。** 约 5 GB 权重、5.3 GB 以上公开 GPU 峰值和 compile warmup 会与本地 Ollama/ASR/VAD 争用显存/内存。Rust 的“180 秒后仍 starting”逻辑可复用，但需要 dots 专属 venv、ready marker、版本/hash lock、真实 CUDA tensor + 一次 reference synthesis smoke。

## 3. 分阶段接入建议

### P0：离线、无 App 接入的 CUDA A/B

- 固定 `dots.tts==0.3.1`、官方仓库 commit、checkpoint revision 和文件 SHA-256；独立 `.venv-dots`，不污染 `.venv-qwen3`，不将模型/缓存/试听报告加入 git 或 Tauri resources。
- 先测 `dots.tts-mf` 普通 `generate_stream()`；同时以 `soar` 作为“最高相似度但更慢”的质量上界。STTS 放在普通流式通过后，不一开始同时改变模型和文本分片策略。
- 在 RTX 5080 上沿用项目既有门槛：torch 必须是 cu128，`torch.cuda.get_arch_list()` 包含 `sm_120`，真实 CUDA tensor smoke、模型 load、参考音首块和完整生成全部通过。Linux 只在实际目标机另测；CPU 不作为实时候选。
- 使用与 Qwen/VoxCPM/Higgs 相同的固定中文、中英混合、数字、多音字、短感叹和 60 秒上限语料，至少 20 条 x 10 次。记录 TTFA p50/p95、RTF、峰值显存、CER、speaker similarity 最低值/离群率、句首/句间接缝、100 次生成后的显存趋势和取消恢复；人工盲听“像不像元元”和情绪自然度。

**P0 通过门槛（项目建议，不是上游事实）：** 音色最低值与离群率显著优于当前 Qwen 或至少不劣于 VoxCPM；CER 不回归；目标机 TTFA p95 < 600 ms、RTF p95 < 0.8；100 次无崩溃/持续显存增长；取消后下一请求可恢复。未达到就停止，不因公开平均 SIM 较高而接 App。

### P1：新增可选 `dots` 后端，先保持句级普通流式

- 新增 `scripts/local-realtime/server_dots.py`，注入 `_synth_tts`、`_synth_tts_stream` 和 HTTP WAV；只在 `managed-v1` 双向协商后声明 `provider-pcm-v1`。
- Rust `voice_service.rs` 增加 backend normalization、独立 WS/HTTP port、Python candidate、setup/ready/hash/smoke、fingerprint 和 stale epoch 防护；`lib.rs` / settings 增加固定枚举和 UI。`api.rs` 的本地 `/api/tts` 转发结构无需新增 provider 专用路由。
- 复用 Qwen/VoxCPM 的参考音 preset 选择；启动期缓存 speaker conditioning。不得把绝对路径、prompt text、PCM、模型异常原文加入日志或 diagnostics。
- 仍让 `StableSentenceBuffer` 按现有 30 字/完成 flush 产出句段；每次 provider chunk 最多 80 ms，单次只拉一个 `next()`，发送按 1x source clock pacing，候选暂停时平移时钟，避免拒绝后突发音频。
- HTTP 朗读可返回 48 kHz WAV，也可统一 24 kHz；实时必须固定 24 kHz PCM。选择需写确定性采样率测试，不能靠 MIME 或字节长度猜测。

### P2：仅在 P1 稳定后实验 STTS 双流式

- 在 Python LLM producer 与 dots session 之间增加有界 token bridge；把 SSE 字符串增量转换成稳定 tokenizer ids，必须有前缀一致性/回滚测试。每个 generation 只允许一个 session，队列容量建议沿用 32 event / 4 sentence 上限，不增加无界 text/audio 缓冲。
- 维持句段 ledger：可以在一句尚未完成时发 PCM，但只有该 `segmentId` 最终完整结束且 Worklet receipt 返回后，清洗后的句文本才能进入 audible history。取消、EOS 异常、错序、样本不符和未完成尾部全部丢弃。
- 分别测 LLM 首 token、达到 STTS lookahead、模型首 PCM、240 ms reservoir、首音频播放五段延迟；与 P1 句级路径同文 A/B。STTS 必须在端到端 TTFA 或自然度上有明确收益才保留。

### P3：macOS 与发行评估

- 官方 runtime 未支持 MPS。只有 community MLX port 经代码/许可证/权重转换审计、固定 revision/hash、真实 Apple Silicon A/B，并满足与 P0 相同的取消/内存/音色门槛后，才可讨论 Mac 后端。
- 发行前补充参考音的权利与同意记录、AI 合成音披露、用户删除参考音/模型缓存路径、第三方 NOTICE。Apache-2.0 解决了代码/权重许可基础，但不会自动解决声音肖像、表演者或素材来源权利。

## 4. 明确不做

- 不修改 `src-tauri/src/realtime.rs::protocol`；dots.tts 属于本地级联 TTS，`KXAU` 也不是火山协议。
- 不直接替换 `local` 的 Qwen3 默认值；新后端必须是独立枚举、独立环境和可回退选项。
- 不把 48 kHz payload 塞进当前 24 kHz envelope，也不把完整 WAV 事后切块宣称 provider streaming。
- 不因模型卡写了 double-streaming 就跳过目标硬件测试；接口能力、模型 TTFA 与最终可播放延迟是三件不同的事。
- 不把官方 benchmark 当元元音色验收，不把 `dots.tts.edit` 的离线编辑标签当实时情绪控制。
- 不记录/导出 prompt audio、逐字文案、合成文本、PCM、模型缓存路径或原始异常；diagnostics 只增加固定 backend/runtime/stream capability 枚举和有界数字指标。

## 5. 最终判断

**可能性：高。** 普通流式 adapter 的接口和现有本地后端高度一致，预计无需改 WebView 音频协议或 Memory/主动带聊框架。

**当前适配度：Windows/Linux CUDA 中高，Apple Silicon 低，CPU 低。** STTS 与产品方向高度匹配，但接入复杂度高于普通流式，且尚无目标硬件证据。

**相对优势：** Apache-2.0、官方 48 kHz 真流式、独有的 same-request token/audio 双流式、公开中文和 speaker similarity 强、比 Higgs 轻且无其发行许可阻断。

**相对劣势：** 比当前 Qwen 0.6B/1.7B 更重，官方快速路径依赖高端 CUDA；Mac 官方 runtime 不可用；没有 CosyVoice/Higgs 那样清晰的实时 instruction/control；云后端的零本地资源和运维优势也无法取代。

所以推荐顺序是：**先做 MF/SOAR 离线同机 A/B -> 胜出后加 `dots` 可选 CUDA 后端 -> 句级普通流式稳定后再做 STTS -> 最后才评估第三方 MLX。** 在完成 P0 前，最佳产品决策仍是 Qwen3 默认、本地 VoxCPM/dots 候选 A/B、CosyVoice/火山保留云端路径；Higgs 维持退役状态。
