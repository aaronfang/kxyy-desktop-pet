# Qwen3-ASR 与 Qwen3-TTS-12Hz-1.7B-CustomVoice 接入调研

调研日期：2026-08-11。以下只采用 Qwen 官方 Hugging Face 模型卡、QwenLM 官方 GitHub 源码及 Apache 许可证；模型卡内容可能随上游更新，实施前应固定 commit/revision 并重新验收。

## 一手来源

- [Qwen3-ASR collection](https://huggingface.co/collections/Qwen/qwen3-asr)
- [Qwen3-ASR-1.7B model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)（[README 原文](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/raw/main/README.md)，HF revision `7278e1e70fe206f11671096ffdd38061171dd6e5`）
- [QwenLM/Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)（调研时 HEAD `7c6daf77a2421100f5fb066495372c00129d39ff`）
- [Qwen3-TTS-12Hz-1.7B-CustomVoice model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)（[README 原文](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/raw/main/README.md)，HF revision `0c0e3051f131929182e2c023b9537f8b1c68adfe`）
- [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)（调研时 HEAD `022e286b98fbec7ec1e916cb940cdf532cd9f488e`）
- 两个模型仓库均声明 `license: apache-2.0`，许可证文本：[ASR LICENSE](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/raw/main/LICENSE)、[TTS LICENSE](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/raw/main/LICENSE)。

## Qwen3-ASR

### 能力与接口

ASR-1.7B 和 0.6B 支持语言识别及转写：30 种语言、22 种中文方言（模型卡表格列出语言/方言），输入类型包括语音、唱歌和带 BGM 的歌曲；统一支持离线和流式推理，并可处理长音频。另有 Qwen3-ForcedAligner-0.6B，可在最多 5 分钟、11 种语言上返回词/字级时间戳。

官方 `qwen-asr` Python 包提供 Transformers 与 vLLM 后端。Transformers 示例使用 `Qwen3ASRModel.from_pretrained("Qwen/Qwen3-ASR-1.7B", dtype=torch.bfloat16, device_map="cuda:0")`，`transcribe(audio=path|URL|base64|(numpy,sr), language=...)` 返回 `language` 与 `text`；可初始化 forced aligner 后请求 `return_time_stamps=True`。vLLM 可启动 `qwen-asr-serve`，并提供 OpenAI-compatible `/v1/chat/completions` 音频消息接口。

流式实现的硬约束来自官方源码 [`qwen3_asr.py`](https://github.com/QwenLM/Qwen3-ASR/blob/7c6daf77a2421100f5fb066495372c00129d39ff/qwen_asr/inference/qwen3_asr.py)：仅 vLLM 后端；单流、不可 batch、不可时间戳；输入是 16-kHz 单声道 PCM，按 `chunk_size_sec`（示例默认 2 秒）累积，每个解码步会把从流开始的全部音频重新送入模型，并通过前缀回滚抑制不稳定尾部。`finish_streaming_transcribe` 对尾部不足整块的音频再做一次解码。因此它不是当前项目 RMS/VAD 的替代品，也不提供神经端点决策。

### 依赖、平台与资源

官方安装要求 Python 3.12 隔离环境；`pip install -U qwen-asr` 为 Transformers，`qwen-asr[vllm]` 才有 vLLM 流式。官方建议 FlashAttention 2（仅 `torch.float16`/`bfloat16`）降低长音频/大 batch 显存。官方流式 demo 是 Flask + 浏览器 16-kHz 重采样，并通过 NVIDIA CUDA/vLLM 运行；Docker 示例要求 NVIDIA Container Toolkit。模型卡没有承诺 Apple MLX/MPS 或 CPU realtime 支持，不能把现有 macOS MLX 路径直接套用。

截至上述 revision，HF API 列出的 1.7B 权重为两个 safetensors 分片，HTTP `Content-Length` 约 4,220,320,824 + 478,200,688 字节（约 4.37 GiB 十进制 4.70 GB），另需 tokenizer/config/runtime；这是下载量，不是运行峰值显存。模型卡只给 vLLM 的 `gpu_memory_utilization` 配置示例（0.7--0.9），没有可承诺的单卡 VRAM/RTF 数字。0.6B 是较低资源候选，但同样没有官方 CPU/MLX 性能保证。

### 接入判断

它可替换本项目“最终 ASR”适配器（保留既有 RMS 候选、确认、端点和 512 字符/重复文本安全门）：Python 服务启动时一次选择 Qwen3-ASR 或 Whisper，ASR admission 仍为 1，阻塞 Future 完成前不释放；流式 vLLM 结果只能作为候选文本展示/最终 ASR 输入，不能驱动 VAD、barge-in 或播放决策。需要新增 CUDA/vLLM 专用环境或服务，无法复用现有 macOS MLX Qwen TTS venv；Windows/Linux NVIDIA 才是现实首选。模型和代码均 Apache-2.0，但仍需保留许可证/NOTICE，并在发布包中遵守 Apache 条款。

## Qwen3-TTS-12Hz-1.7B-CustomVoice

### 能力与接口

模型卡宣称 10 种主要语言（中、英、日、韩、德、法、俄、葡、西、意），CustomVoice 提供 9 个固定高级音色，支持自然语言 `instruct` 控制情绪、语速、音调/韵律。可用 speaker：`Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Ryan`, `Aiden`, `Ono_Anna`, `Sohee`；中文最佳音色是 Vivian/Serena/Uncle_Fu，Dylan/ Eric 分别为北京/四川方言。接口是 `Qwen3TTSModel.from_pretrained(..., device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="flash_attention_2")`，然后 `generate_custom_voice(text, language, speaker, instruct)`，返回 `(wavs, sample_rate)`；模型卡示例用 `soundfile.write` 保存波形。它不能从用户参考音频克隆；克隆属于 `1.7B-Base`，VoiceDesign 属于另一模型。

模型卡概述 Dual-Track streaming，声称单字符即可产生首个音频包、端到端延迟最低 97 ms；但当前官方 Python 实现 [`qwen3_tts_model.py`](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7ec1e916cb940cdf532cd9f488e/qwen_tts/inference/qwen3_tts_model.py) 的 `generate_custom_voice` 最终调用 tokenizer `decode` 并返回完整 `List[np.ndarray]`。其 `non_streaming_mode` 文档明确写着：设为 `false` 目前只是“模拟 streaming text input”，并非真正 streaming input 或 streaming generation。官方 README 的 vLLM-Omni 段落也明确当前“only offline inference”；在线服务和进一步 streaming 支持尚未提供。因此不能把 97 ms 宣称当作本地 Python API 已验证的首包 SLA。

### 依赖、平台与资源

官方建议 Python 3.12 新环境、`pip install -U qwen-tts`，FlashAttention 2 可降低显存；vLLM-Omni 目前只离线。模型卡没有官方 Apple MLX/MPS、Windows CPU 或 Linux CPU realtime 支持声明；源码对 `mps` 做了部分 autocast 特判，但这不等于端到端 MPS 可用性。HF API 列出的 1.7B CustomVoice `model.safetensors` 约 3,833,402,552 字节，speech tokenizer `model.safetensors` 约 682,293,092 字节，合计约 4.52 GB（另加 tokenizer/config、PyTorch runtime）；无官方峰值 VRAM/RTF 表。模型卡的性能表是 WER/SIM/属性指标，不是本机实时速度。

### 接入判断

CustomVoice 的固定 speaker 与 `instruct` 很适合作为元元日常语音（可把 `ttsVoice` 映射到 allow-list speaker，情绪映射为固定短指令），且 Apache-2.0 与现有发布策略兼容。但现有本地/CosyVoice 服务要求有界句子流水线、单车道顺序播放及可选 `provider-pcm-v1` 逐块 24-kHz PCM；官方 Python API 只能在句子级得到完整波形，故第一阶段应作为 buffered TTS 后端：每句完成后再切片/封装，禁止伪造首包或未完成音频 receipt。只有上游正式暴露可消费的流式生成 API 后，才可实现真正 provider-pcm-v1；不能根据 README 的 97 ms 或 `non_streaming_mode=false` 自行推断。

模型固定 9 音色，不满足项目现有 `localRefWav`/个性化克隆契约；应保留 Base/现有 Qwen3-TTS 路径作为需要参考音频的模式。1.7B 权重下载量约 4.52 GB，和 ASR 同机常驻会造成约 9 GB 以上权重占用，尚未计入 CUDA 图、KV/cache 和 Python，建议互斥加载或单独服务进程，并沿用项目“不把模型权重打进安装包、首次设置下载/健康检查”的约束。

## 与本项目架构的合并方案

1. **ASR（可行但后置）**：新增 `qwen3-asr` 可选 final-ASR adapter，优先 0.6B；仅在 NVIDIA + vLLM 能力探测通过时启用。RMS/VAD、候选 deadline、barge-in、ASR admission=1、文本安全上限和 playback-derived history 全部保持不变。macOS MLX 及无 CUDA 环境继续 Whisper/SenseVoice。
2. **CustomVoice（可行，先 buffered）**：在现有 `server_*.py`/voice-service 生命周期中加入独立 qwen-tts 环境与固定 speaker allow-list；句子级生成输出转 24-kHz PCM，走现有有界队列、取消检查、60 秒上限和播放 receipt。不要宣称 realtime streaming，不能把模型权重或 PyPI wheel 作为 bundled resource。
3. **不可直接复用处**：Qwen ASR vLLM 与 TTS PyTorch CUDA 依赖不能直接塞进现有 macOS MLX venv；两模型都没有官方 CPU/MPS realtime 承诺。需要安装器/设置 UI 显示模型下载、CUDA/显存和服务状态，失败时保持 Whisper/现有 TTS 回退。
4. **许可证与供应链**：保留两个 Apache-2.0 LICENSE/NOTICE；固定 HF revision、权重 SHA-256 和依赖版本，进行真实 CUDA smoke、长句/取消/并发/音频时长测试。模型卡未给出显存峰值或本项目硬件 RTF，不能在接入前承诺最低硬件或 97 ms 体验。

## 结论

两者技术上都能以“本地 Python 可选后端”接入，但成熟度不同：Qwen3-ASR 的流式接口可用于 NVIDIA/vLLM 的候选/最终转写，却不能改变项目声学决策；CustomVoice 目前最稳妥是句子级 buffered TTS，固定音色和 `instruct` 可覆盖元元语音，但不满足参考音频克隆和真正逐包流式。建议先做独立、可卸载的实验服务与能力探测，再决定是否纳入正式安装器。
