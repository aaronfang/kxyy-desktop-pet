# Higgs TTS 3 (4B) macOS 合入调研（2026-08-10）

## 结论

**技术上值得做 Apple Silicon 离线实验，但当前许可证不允许直接合入并随 kxyy 产品提供给终端用户。** Higgs TTS 3 是约 4B 参数、24 kHz、25 fps、8-codebook 的自回归语音模型；支持中文、100+ 语言、零样本克隆和情绪/风格/停顿/SFX inline control。模型权重约 **8.49 GB**（HF `model.safetensors.index.json` 的 `metadata.total_size`），Mac 应走 MLX-Audio，不应尝试 CUDA/Docker/SGLang。

建议先做**不接入 App 的本地评估分支**：使用 MLX-Audio 的 `bosonai/higgs-audio-v3-tts-4b` loader，以现有 `ref.wav` + `ref.txt` 和固定中文语料测音色、CER、峰值统一内存、RTF、首音频延迟和取消行为。只有 Boson AI 出具覆盖“本地模型嵌入桌面应用/向终端用户分发”的商业许可后，才进入产品 adapter 设计。

## 官方能力与模型形状

- 模型卡声明 backbone 约 4B，自回归 decoder 36 层、hidden 2560、GQA 32/8；上下文训练长度 8,192；8 个 codebook，每个 vocab 1,026；24 kHz、25 fps（40 ms/frame）。[Hugging Face model card](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/README.md#model-overview)
- 模型卡把中文列入 WER/CER <5 的 85 个“polished”语言，并称覆盖 102 个语言的单个位数 WER/CER；这些是供应方 benchmark，不能替代元元参考音上的 A/B。[Supported Languages / Evaluation](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/README.md#supported-languages)
- 控制 token 是 `<|emotion:value|>`、`<|style:value|>`、`<|prosody:value|>`、`<|sfx:value|>`；emotion/style/全局 speed/pitch/expressive 应放句首，pause/long_pause/SFX 按位置插入，SFX 后必须紧跟拟声词。不能把项目现有情绪字符串未经 allow-list 直接传入。[PROMPTING.md](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/PROMPTING.md)
- 参考音频的 transcript 会显著改善克隆 fidelity；模型卡示例用 `references: [{audio_path, text}]`。项目现有 `ref.wav/ref.txt` 资产形状可复用，但必须先确认音频权利和本人同意。[Voice cloning example](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/README.md#voice-cloning)

## macOS Apple Silicon 可行性

**模型名需要先锁定。** 用户提供的权重仓库是 `bosonai/higgs-tts-3-4b`；MLX-Audio v3 文档示例加载的是 `bosonai/higgs-audio-v3-tts-4b`。虽然两者都指向 Higgs Audio v3 家族，当前不能仅凭名称把它们当作同一发布物：实验脚本必须记录实际 repo id、revision、`config.json`、文件清单和权重 SHA-256，先完成可复现性校验再决定 loader 与缓存目录。

Hugging Face 模型仓库自带的操作指南把 Apple Silicon 单列为 MLX-Audio 路径：无需 NVIDIA GPU，安装 `pip install mlx-audio`，并声称在 M1/32 GB 上实测峰值内存约 9–12 GB。该数字是模型发布方的 first-hand measured 说明，不是本项目测量，仍需在目标 Mac（芯片、统一内存、macOS、MLX 版本）复测。[官方仓库 `AGENTS.md` 的 Path C](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/AGENTS.md#path-c--apple-silicon-mac-via-mlx-audio-no-nvidia-gpu)

MLX-Audio 当前主分支已列出 Higgs Audio v3，并提供 v3 loader、参考音克隆、参考 codes 缓存、批量生成和 inline controls；示例调用 `load("bosonai/higgs-audio-v3-tts-4b")`，输出为 24 kHz 音频。当前 v3 README 没有给出 `stream=True` 或逐 PCM chunk API，不能假设它能直接满足项目的 `provider-pcm-v1` 流式 TTS 契约。[MLX-Audio v3 README](https://github.com/Blaizzy/mlx-audio/blob/41aba815e716623b4d94647c09cc88de9999e97c/mlx_audio/tts/models/higgs_audio_v3/README.md)

MLX-Audio 文档仍使用旧标识 `bosonai/higgs-audio-v3-tts-4b`，用户给出的新标识是 `bosonai/higgs-tts-3-4b`；两边当前的 safetensors index SHA-256 相同，但集成时仍应以 `higgs-tts-3-4b` 固定 revision 做真实加载 smoke，不能永久依赖别名关系。

### 2026-08-10 情绪音色漂移诊断

Legacy 15.9s 参考音在整体试听中优于 Qwen-MLX，但情绪矩阵中的以下样本被听感判定为“换了一个人”：`emotion-amusement-r01/r02`、`emotion-contemplation-r02`、`emotion-surprise-r01/r02`。

这与 Higgs 控制 token 的语义一致，而不是生成失败：模型文档说明句首的 emotion、speed、pitch、expressive token 会重塑整句 delivery。固定 Legacy reference、同一文本、temperature 0.3 的差分样本中，粗略基频统计如下（仅作诊断信号，不是 speaker embedding）：

| 文本 | 无控制 | 仅 emotion | emotion + prosody |
|---|---:|---:|---:|
| amusement | 114.8 Hz | 121.2 Hz | 152.0 Hz (`expressive_high`) |
| surprise | 113.7 Hz | 247.4 Hz | 262.3 Hz (`pitch_high`) |
| contemplation | 107.6 Hz | 107.1 Hz | 104.8 Hz (`speed_slow`) |

人工听测确认：`surprise` 的 full 版本完全变成另一位说话人，emotion-only 也基本不像，只有无控制版本音色正常；因此身份漂移主要由 emotion 本身造成，`pitch_high` 会进一步放大。`amusement` 的 full 版本音色不够像，但 emotion-only 尚可接受，说明主要风险来自叠加的 `expressive_high`。`contemplation + speed_slow` 的 full 版本音色可接受。降低 temperature 只能降低随机性，不能消除高风险控制 token 的身份改变。

试听矩阵：`scripts/higgs-ab/reports/diag-emotion-ab/index.html`。在产品适配前，情绪映射应默认为“保音色”策略：禁用 `surprise`、`pitch_high`、`expressive_high`；`amusement` 只允许 emotion-only；`contemplation + speed_slow` 可进入下一轮稳定性验证。高风险情绪应改由文本措辞和标点表达，而不是替换成未经验证的相近 token。每个允许的 emotion 仍需经过固定参考音的音色相似度最低值、重复生成稳定性和人工盲听门槛。

上游 model card 的 GPU 服务入口是 SGLang-Omni/vLLM-Omni，官方性能数据以 H100/A100 为主，且 SGLang 路径需要约 40 GB VRAM 才是已确认 floor；这不适用于 Apple Silicon。上游 SGLang API 可 SSE 返回 base64 WAV chunks，但它不能作为 Mac 本地方案。[SGLang/vLLM usage](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/README.md#sglang-usage)

## 许可证与产品阻断

模型使用 **Boson Higgs TTS 3 Research and Non-Commercial License**，且明确“不是 open source license”。研究、benchmark、个人非商业测试可用；发布任何允许他人使用的非商业 demo 需要附协议、NOTICE 和合理署名。[LICENSE](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/LICENSE)

对本项目最关键的是许可证 Section II-A(c)：Creator Use Grant 只覆盖创作者生成并发布/变现 podcast、视频等内容；**不覆盖** hosting/API/end-user application、把模型嵌入产品或服务、重新分发/转售/为分发而量化或微调。这正好覆盖 kxyy 桌面应用的产品形态，因此在取得单独书面 commercial license 前不得把权重、MLX 转换物或本地 voice service 随应用交付。[LICENSE §II-A(c), §III](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/LICENSE#L45-L88)

许可证还要求未经明确、可验证同意不得克隆真人声音；公开合成音在法律要求或可能误导时要清楚披露；分发时保留协议/NOTICE 及 Boson 署名。量化、转换、格式转换版本属于 Derivative Work，不能因为 MLX 转换后体积更小就规避许可。[LICENSE §IV(a), §IV(b), §V](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/LICENSE#L107-L180)

## 与 kxyy 架构的实验合入方案

### 当前仓库实验状态（2026-08-11）

本仓库已在不改变默认 Qwen3 后端的前提下接入一个仅 macOS Apple Silicon 可选的 Higgs 实验后端：Rust voice-service 管理 `server_higgs.py`，实时通话通过现有 `managed-v1` / `provider-pcm-v1` 契约下发 24 kHz PCM。MLX v3 的内部生成钩子被包装为有界滚动解码；文本按自然子句拆分，首段和后续子句使用不同的有限预缓冲，短文本有最大生成预算以防止持续音退化。

实测结论：Higgs 音色稳定性明显优于此前的流式实验，但在当前 Mac MLX 路径上仍慢于 Qwen3。A/B 离线报告的生成 RTF 中位数约为 Higgs `1.29`、Qwen3 `0.49`；这主要来自 4B 自回归模型相对 0.6B Qwen3 的推理成本。该实验后端不改变默认语音设置，也不把模型权重、缓存或试听报告打包进应用。

后续模型尝试应以当前 Higgs 实现作为隔离实验基线，优先比较：首音频时间、RTF、长句连续性、ASR 抢占、音色漂移和取消后的旧 generation 音频。当前代码仍是本地个人测试路径，不代表已完成商业授权或发行准备。

### P0：独立 macOS 实验，不改现有默认后端（已完成）

1. 在 `scripts/local-realtime` 增加隔离的 MLX-Higgs v3 Python 环境/服务，不复用 Qwen venv，不把模型或 Hugging Face cache 加入 Tauri resources。
2. 服务启动前做 Apple Silicon/MPS/统一内存预检，下载模型到用户 App-data；记录固定版本、权重 SHA-256、MLX-Audio commit 和内存上限。没有 MPS 或内存不足时保持 `unsupported`，RMS/现有 Qwen 路径继续工作。
3. 复用现有 `ref.wav/ref.txt`，在 Rust voice-service 的 backend/fingerprint/epoch 状态中增加 `higgs-mlx`；服务健康检查仍只返回固定 `kxyy-voice`，日志和诊断禁止模型路径、文本、PCM、原始异常。
4. HTTP 朗读保留整段 WAV；实时通话另走受能力协商保护的滚动解码路径。两者均复用现有 admission、取消和 generation 隔离边界。

### P1：接入实时本地/CosyVoice 契约（已完成实验版）

实验服务使用 MLX v3 内部生成钩子做滚动 codec 解码，并且只在客户端与服务端共同协商 `provider-pcm-v1` 后启用。输出统一为 24 kHz、16-bit PCM，严格套用现有 Rust/JS `KXAU` envelope、generation/segment/sequence 和 60 秒/64 项上限；取消、序列不匹配或缺失完成边界的流不会产生可听完成回执。公开 API 或内部钩子不可用时，服务自动降级到整段缓冲路径，不伪造流式能力。

### 不应做的事

- 不修改 Volcano `realtime.rs::protocol`；Higgs 是本地 provider，不能借用 Volcano 常量。
- 不把 Higgs inline control token 直接暴露给用户输入或同步 persona；只允许固定映射后的内部 emotion/style/prosody allow-list。
- 不在取得 commercial license 前把模型、转换权重、安装器、服务端脚本打包到发行版。

## 验收门槛

在任何产品代码合入前，至少完成：固定中文/中英混合语料 20 条 × 10 次；音色 embedding 最低值/离群率不劣于当前 Qwen 基线；CER、首音频延迟、RTF、峰值统一内存；连续 100 次生成无崩溃/显存或统一内存持续增长；挂断、barge-in、取消不会产生过期 generation 的可听片段；模型/MLX 版本和权重哈希可复现；许可证书面覆盖桌面端终端分发及本地模型运行。

## 主要来源

- [Hugging Face model card](https://huggingface.co/bosonai/higgs-tts-3-4b)
- [Hugging Face model `AGENTS.md`](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/AGENTS.md)
- [Hugging Face `config.json`](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/config.json)
- [Hugging Face `model.safetensors.index.json`](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/model.safetensors.index.json)
- [Hugging Face `LICENSE`](https://huggingface.co/bosonai/higgs-tts-3-4b/blob/main/LICENSE)
- [MLX-Audio Higgs v3 README](https://github.com/Blaizzy/mlx-audio/blob/41aba815e716623b4d94647c09cc88de9999e97c/mlx_audio/tts/models/higgs_audio_v3/README.md)
- [Boson AI Higgs Audio source](https://github.com/boson-ai/higgs-audio)
