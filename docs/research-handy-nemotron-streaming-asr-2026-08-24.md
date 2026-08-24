# Handy、Nemotron 3.5 Streaming 与本项目语音链路调研

研究日期：2026-08-24
研究对象：[`cjpais/Handy`](https://github.com/cjpais/Handy/tree/af48dd68a64d58aad128fdbb920492a03da53c79) `v0.9.6` / commit `af48dd68a64d58aad128fdbb920492a03da53c79`，以及 NVIDIA、SenseVoice、NeMo-Speech.cpp、sherpa-onnx 的一手资料。

## 结论摘要

1. **用户所称的“SenseVoice2”并不是本项目当前实现。** 当前项目实际使用的是 `sherpa-onnx 1.13.4 + SenseVoiceSmall INT8 2024-07-17`，CPU、whole-utterance、final-ASR-only；它在进程启动时一次选定，不参与 VAD、端点、候选确认或打断。本报告统一称为 **SenseVoiceSmall INT8**。
2. **Nemotron 3.5 ASR Streaming 0.6B 值得做隔离 A/B，但现有证据不支持直接替换 SenseVoiceSmall。** 它的明确优势是原生 cache-aware RNN-T 流式推理、稳定/暂定 partial 的可能性、更多语言以及多种延迟档位。中文 `zh-CN` 只在 NVIDIA 的 `Broad-coverage` 层；官方 FLEURS 中文 CER 约为 `19.28%--20.56%`，不能与 SenseVoice 的不同数据集结果横向比较，更不能据此声称中文更准。实机复现还确认 Handy 的 Q8 runtime 会对部分 0.19--0.55 秒干净中文短词稳定返回空，短确认词必须单列为接入门槛。
3. **Handy 没有实现 AEC 或实时降噪 DSP。** 其主链路是 `CPAL 麦克风 -> 重采样至 16 kHz -> Silero VAD 帧保留/丢弃 -> ASR`。另有默认关闭的“录音时静音系统输出”，这是直接静音，不是 AEC，也不适合本项目全双工通话。试用时对外放声的良好表现，可能来自设备/系统麦克风处理、Silero 删除非语音区间、ASR 模型鲁棒性或开启了系统静音；源码不足以把它归因于 Handy 的回声消除。
4. **对本项目最有价值的吸收项不是照搬 Handy 整条链路。** 优先级依次是：原生流式 ASR 的 `committed/tentative/final` 契约；能力驱动且 hash/revision 固定的模型目录；真实首帧就绪握手、设备/声道选择和自检；模型预热/闲置卸载。Nemotron 原型应优先评估 NVIDIA 官方 **NeMo-Speech.cpp**，不先复制 Handy 的 `transcribe.cpp` 集成。
5. **噪声、外放和模型准确率必须拆成独立变量测试。** Nemotron、Silero VAD 与 WebView `getUserMedia` AEC/降噪解决的是不同问题。先做 `ASR x VAD x AEC` 因子实验，再决定是否接产品；不能用一次主观试用替代双讲和 playback-only 测试。

## 一、本项目真实基线

### 1.1 当前是 SenseVoiceSmall，不是“SenseVoice2”

本项目 [`asr_adapter.py`](../scripts/local-realtime/asr_adapter.py) 固定：

- `sherpa-onnx 1.13.4`；
- `sensevoice-small-int8-2024-07-17`；
- `model.int8.onnx + tokens.txt`；
- 16 kHz PCM，`OfflineRecognizer.from_sense_voice(...)`，`num_threads=2`、`language="auto"`、`use_itn=true`、`provider="cpu"`；
- 一次性把整段 PCM 送入 recognizer，再 `decode_stream` 取得 final；
- 输出只允许 `zh/yue/en/ja/ko/nospeech`、固定 emotion/event 枚举，未知 provider tag 全部删除；
- runtime 缺失或损坏时，启动期固定回退 Whisper，不在通话中途双跑或切换。

具体契约见 [`asr_adapter.py` L19-L34](../scripts/local-realtime/asr_adapter.py#L19-L34)、[`L251-L361`](../scripts/local-realtime/asr_adapter.py#L251-L361) 和 [`L372-L393`](../scripts/local-realtime/asr_adapter.py#L372-L393)。安装器还对 wheel、模型 archive、内部文件大小与 SHA-256 做了完整锁定，见 [`sensevoice-runtime-lock.json`](../scripts/local-realtime/sensevoice-runtime-lock.json)。

SenseVoice 官方将 Small checkpoint 描述为非自回归端到端模型，支持普通话、粤语、英语、日语、韩语，同时输出语言、情绪和音频事件。官方给出的“10 秒音频约 70 ms”和“比 Whisper-Large 快 15 倍”来自其特定 benchmark 配置，不是本项目 sherpa-onnx INT8 在目标设备上的实测；官方也把 VAD 作为可单独启停的外部环节，而不是模型内 AEC。[官方模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/3847d57b6bdf2dd8875cb1508d2af43d80a16bf7/README.md)

### 1.2 当前全双工链路已经有采集端处理，但仍未完成声学验收

本项目通过 WebView `getUserMedia` 明确请求 `echoCancellation: true`、`noiseSuppression: true`、`autoGainControl: true`，再由 AudioWorklet 输出 16 kHz PCM，见 [`realtime.js` L695-L710](../src/ai/realtime.js#L695-L710)。这比 Handy 的 raw CPAL 采集更接近全双工回声场景，但它只是对平台 WebView 音频处理的请求，不能推导为每个 macOS/Windows、设备和扬声器摆位都已可靠 AEC。

本地/CosyVoice 实时决策仍由 RMS 阈值、候选窗口、soft-end/reopen 和 final ASR 共同完成；Silero 只以 shadow 模式观测，不能驱动打断。当前 `docs/realtime-device-acceptance.md` 也明确把内置扬声器、耳机、1 米外放、安静播报、真实打断、短咳/环境声与恢复列为待执行的实机验收，而不是已通过事实。

## 二、Nemotron 3.5 与当前 SenseVoiceSmall 对比

| 维度 | Nemotron 3.5 ASR Streaming 0.6B | 本项目 SenseVoiceSmall INT8 | 对本项目的含义 |
| --- | --- | --- | --- |
| 架构 | 24 层 cache-aware FastConformer encoder + prompt-conditioned RNN-T，约 600M | 非自回归 SenseVoiceSmall；Handy 目录标 234M，本项目使用 INT8 ONNX | Nemotron 复杂度和常驻内存更高，但原生流式状态可复用 |
| 流式 | 原生、无重叠 chunk；80/160/320/560/1120 ms 可调 | 当前 whole-utterance final only；官方列出的第三方 pseudo-streaming 会牺牲精度 | Nemotron 的首要价值是 partial/最终延迟，不是先验中文精度 |
| 语言 | 40 locales tokenizer；32 个开箱可转录，8 个 adaptation-ready；支持自动语言标签 | `zh/yue/en/ja/ko` 五种，含粤语 | Nemotron 覆盖广，但没有粤语；元元核心中文场景不因“语言更多”自动获益 |
| 中文地位 | `zh-CN` 属 Broad-coverage；官方 FLEURS CER：已知语言从 80 ms 的 20.56% 到 1.12 s 的 19.28%，auto 1.12 s 为 19.87% | 官方声称中文/粤语相对 Whisper 有优势，但其表格、数据集和 runtime 与 NVIDIA 不同 | 不可跨模型卡横比；必须用同一中文语料、同一采集链路和同一规范化器 |
| 附加理解 | 标点、大小写、语言检测、token timestamps | 语言、情绪、BGM/笑/哭/咳嗽等事件；本项目仅输出审核过的固定枚举 | 换成 Nemotron 会失去当前 `UserAffect` 候选来源，需显式保留/降级 |
| 官方 runtime | NeMo / Transformers；官方 NeMo-Speech.cpp 提供 GGUF、CPU/Metal/Vulkan/CUDA、C ABI、本地 WS | 本项目已用 sherpa-onnx CPU wheel 和 INT8 ONNX，安装/回退成熟 | Nemotron 原型是新 runtime 与新生命周期，不只是换模型文件 |
| 模型大小 | Handy 默认 Q8 文件 751,094,240 bytes；Q4 约 496 MB，F16 约 1.28 GB | 本项目 ONNX 239,233,841 bytes，模型 archive 约 163 MB | Nemotron 下载、RSS/统一内存、冷启动和同 TTS 争用均更高 |
| 硬件证据 | NVIDIA NeMo 卡重点是 Linux + NVIDIA GPU；NeMo-Speech.cpp 扩展到跨平台 CPU/Metal/Vulkan/CUDA | 当前 macOS arm64/x64、Windows x64 CPU 路径已固定和 smoke | 要分别验证 M 系列 Metal/CPU 与 Windows RTX/CPU，不能用 H100 数据外推桌面端 |
| 许可 | 模型 OpenMDW-1.1；分发须保留协议和适用的 copyright/origin notices；模型卡称 commercial-ready | 模型权重 FunASR Model Open Source License 1.1，要求注明来源/作者并保留模型名；sherpa-onnx runtime 有独立许可 | 两者都不是仅看 SPDX 就结束；若分发 GGUF/runtime，需固定 license/notice/hash 审核 |

Nemotron 一手依据：NVIDIA [模型卡固定 revision `1c8deae`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/blob/1c8deaecc64b91f034d73e08dd8b64625eb3395d/README.md)、[OpenMDW 1.1](https://openmdw.ai/license/1-1/)。SenseVoice 依据：[官方仓库固定 commit `6991744`](https://github.com/FunAudioLLM/SenseVoice/tree/6991744856587fa44379e8b5dcc432debffeb1be)、[模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/3847d57b6bdf2dd8875cb1508d2af43d80a16bf7/README.md)、[FunASR 模型许可 1.1](https://github.com/modelscope/FunASR/blob/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE)。

### 2.1 延迟数据应如何解读

NVIDIA 公布的 80--1120 ms 是声学 chunk/right-context 配置，不等于“用户停说到 final 文本”的完整端到端延迟；还要计入特征提取、实际硬件推理、队列、final flush、端点和 IPC。模型卡公布的并发流和 final-token 延迟图是在单张 H100 上测得，不能外推到 M4、RTX 5080 或 CPU。

Handy 使用其维护者转换的 GGUF，而不是直接加载 NVIDIA 原 checkpoint。该 GGUF 卡报告 Q8 在 M4 Max 上 Metal `98x`、CPU `29x` real-time，在 Ryzen 4750U 上 Vulkan `14.5x`、CPU `7.5x`；这些是 Handy/transcribe.cpp 维护者的一手测试，主要给出英语集验证，不是 NVIDIA 官方桌面基准，也不是中文、噪声或双讲结果。[Handy GGUF 卡固定 revision](https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/blob/6d44e540bc31b0de1dbe174a3cea87f53a7f22fb/README.md)

### 2.2 推荐的 runtime 路径

优先用 NVIDIA 官方 [`NeMo-Speech.cpp`](https://github.com/NVIDIA/NeMo-Speech.cpp/tree/4f9676226f667d14608487df744f375db87127f8) 做隔离原型：

- NVIDIA-authored runtime 代码 Apache-2.0，模型仍遵守 OpenMDW-1.1；
- 官方 README/安装文档明确覆盖 macOS、Windows、Linux，支持 CPU、Apple Silicon Metal、Vulkan、CUDA；
- 提供稳定 C ABI、本地 HTTP/realtime WebSocket，以及固定模型索引、大小和 SHA-256；
- 可以用独立 sidecar 先验证资源、取消、partial/final 和跨平台，不必立即把 C++/GGML 直接嵌入 Tauri Rust 主进程；
- NeMo-Speech.cpp 中的 Silero VAD 也是**独立、默认关闭**的模型，不是 Nemotron 自带降噪或 AEC。[VAD 配置](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/4f9676226f667d14608487df744f375db87127f8/docs/asr/configuration.md#vad-feature-masking)

Handy 的 `transcribe-cpp 0.2.0` 已证明同一 GGUF 能通过 Rust 封装运行，但它是 Handy 生态的聚合 runtime。对本项目而言，先验证官方 runtime 能减少“模型问题、量化转换问题、第三方 runtime 问题”混在一起的归因困难。只有官方 sidecar 达标且 in-process 确实有必要时，再比较直接链接 `transcribe.cpp` 的包体、崩溃隔离和维护成本。

### 2.3 为什么 Handy 卸载后再次按键仍感觉没有加载延迟

这个试用观察与源码一致，但关键不只是 Nemotron 本身加载快：

1. Handy 的卸载只是 drop 当前 native engine、清空当前 model id 并发出状态事件，不删除 GGUF，也没有主动清空操作系统文件页缓存。[`unload_model`](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L413-L443)
2. 用户按下录音快捷键时，Handy 立即在后台线程启动模型加载，同时并行预载 VAD；它不是等用户松键、PCM 收集完成后才加载。[录音 start path](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/actions.rs#L471-L486)、[`initiate_model_load`](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L734-L765)
3. streaming worker 会等待后台加载完成；加载期间到达的音频已由 stream channel 接收，模型 ready 后继续处理。batch 路径也会在真正转录前等待同一个 condition variable。[stream wait](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L825-L846)、[batch wait](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L1183-L1201)
4. 因此，只要“热页缓存下的模型加载时间”短于用户本轮说话时间，加载就完全被录音阶段遮蔽，松键到 final 或持续 partial 的体感几乎不受影响。刚卸载后重新加载还可能受益于 OS page cache；这是合理解释，但 Handy 没有显式缓存第二份 engine，仍需用日志和内存指标验证。

这项设计值得吸收，但不能只测 `unload_model()` 返回多快。原型应分别记录：drop API 耗时、RSS/统一内存/显存回落幅度和时间、冷启动与热页缓存下的 model-ready、按键到 first tentative/committed、停止到 final。快速 drop 不等于所有 native/GPU 资源已归还操作系统，快速热加载也不等于应用冷启动加载同样快。

若本项目引入 Nemotron，可在通话/按住说话开始时并行加载 ASR，并让麦克风采集、AudioContext 准备和 runtime health-check 同时进行；但加载前到达的 PCM 必须进入固定容量队列，溢出时给出明确失败或降级，不能复制 Handy 当前标准 `mpsc::channel` 的无界积压。模型也只能在无通话、无 ASR Future、无 streaming lease 且生命周期 epoch 仍匹配时卸载。

### 2.4 短发言返回空：模型盲区与采集边界会叠加

在 Handy `v0.9.6`、Nemotron Q8、Apple M4 Pro/Metal、`language=auto`、VAD 开启、Bose Bluetooth 麦克风的实机日志中，已观察到两次非空录音最终返回空：VAD 保留后的 PCM 分别约为 1.77 秒和 4.29 秒。两次 streaming final 均为 0 字符，同一 PCM 的 batch fallback 也由 RNN-T decoder 返回 0 token。因而这不是模型尚未加载、Handy 的 filler/post-processing 删除，也不是 streaming finalization 单独失败。

其中 1.77 秒失败样本的峰值约为 -10.4 dB，但在 -35 dB 阈值上只有约 0.2--0.25 秒、彼此分离的明显声学片段；把它放大 3 倍、补静音到 4.77 秒或复制成 3.54 秒仍返回空。对照的 1.65 秒成功样本有约 0.75 秒连续清晰语音。这说明 nominal WAV 时长不是决定因素，真正进入解码器的连续语言证据更重要。

同一模型的 headless CLI 对 macOS `Tingting` 合成、16 kHz mono PCM 做了重复 3 次的确定性对照：

| 干净输入 | 音频时长 | Nemotron final |
| --- | ---: | --- |
| 嗯 / 啊 / 哦 | 0.19--0.29 秒 | 均为空 |
| 行 / 不 | 0.20--0.41 秒 | 均为空 |
| 谢谢 | 0.55 秒 | 空 |
| 不要 | 0.41 秒 | `不` |
| 对 / 喂 / 停 / 好 | 0.26--0.36 秒 | 非空且正确 |
| 在吗 / 好的 / 可以 | 0.41--0.46 秒 | 非空且正确 |
| 这个设计值得吸收 | 1.67 秒 | 非空且正确 |

因此，**Handy 没有一个简单的“短于 N 秒就丢弃”规则；Nemotron Q8/transcribe.cpp 确实会对部分极短中文词和语气词输出 blank，而且不是所有更短的词都会失败。** 这更接近词项、发音和上下文相关的短上下文盲区。`language=auto` 可能放大问题，但尚未完成固定 `zh-CN` 对照，不能把自动语言检测定为根因。

本机已安装的项目当前 SenseVoiceSmall INT8 adapter 对完全相同的 16 条合成 PCM 全部返回了非空 final，约 11 条文字正确；Nemotron 约 9 条正确、6 条为空、1 条截断。SenseVoice 对 `谢谢/行/不要` 等 Nemotron 失败项给出了正确文字，但对若干极短、声学歧义较大的单音节误判为日语或英文，`喂` 也出现乱码式误写，所以这不是“SenseVoice 全面更准”的证据，而是它更倾向于猜测、Nemotron 更倾向于 blank。对同一批 Handy 实录，SenseVoice 也为两条 Nemotron 空结果给出了非空文本：1.77 秒碎片只得到英文 `Oh.`，4.29 秒样本得到重复的 `好的`；同时它把一条 Nemotron 成功的 1.65 秒短样本误写成重复的 `哒`。长句“这个设计值得吸收”则两者都正确。

对本项目的直接含义是：平均 CER 之外必须增加 **empty-final rate、短确认词准确率和错误类型**。Nemotron 的 blank 不应由“沿用上一句”“自动补一个确认词”或把 tentative 写入历史来掩盖；若试验 adapter 最终允许 fallback，也只能在同一有界 PCM 上做一次明确、可观测、不会双重提交的 final fallback，并单独评估额外延迟和 SenseVoice 的短音节误猜风险。

真实按键录音还可能有第二个因素：Handy 保存的是经过 VAD keep/drop 后的音频，无法从现有 WAV 还原最初 raw capture；蓝牙输入建流约需 43--57 ms，若按键后立即说一个短词，首音节起始可能已丢失或被 VAD 切碎。下一步最小实机对照应是：同一短词分别在按键后立即说与等待 300--500 ms 再说、VAD 开/关、内置麦克风/Bose、`auto`/固定 `zh-CN` 下重复。若干净短词在固定中文仍为空，应作为模型/runtime 限制上报；若等待和关闭 VAD 能恢复，则优先修采集 ready 握手与 pre-roll，而不是给 ASR 输入补静音。

## 三、Handy 的环境噪声与外放处理到底是什么

### 3.1 源码可证实的链路

```text
CPAL 麦克风输入
  -> 选择一个声道或多声道平均
  -> 原设备采样率重采样为 16 kHz / 30 ms frame
  -> Silero VAD 概率阈值 + onset/prefill/hangover
  -> 保留 speech frame，丢弃 noise frame
  -> streaming ASR 或 batch ASR
```

证据：

- capture 与声道处理：[`recorder.rs` L420-L488](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/audio_toolkit/audio/recorder.rs#L420-L488)；
- 16 kHz 重采样与 VAD keep/drop：[`recorder.rs` L675-L747](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/audio_toolkit/audio/recorder.rs#L675-L747)；
- Silero 每 30 ms 输出概率，Handy 阈值 `0.3`：[`silero.rs` L9-L56](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/audio_toolkit/vad/silero.rs#L9-L56)、[`audio.rs` L20-L22](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/audio.rs#L20-L22)；
- 平滑器要求 2 个连续 positive frame，保留 15 frame prefill；offline hangover 15 frame（约 450 ms），streaming hangover 55 frame（约 1.65 s）：[`vad/mod.rs` L3-L12](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/audio_toolkit/vad/mod.rs#L3-L12)、[`smoothed.rs` L40-L109](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/audio_toolkit/vad/smoothed.rs#L40-L109)。

### 3.2 四个容易混淆的概念

| 层次 | Handy 实际情况 | 能解决什么 | 不能解决什么 |
| --- | --- | --- | --- |
| Denoise / noise suppression | 未发现 RNNoise、DeepFilter 或其它实时降噪 DSP | 无 | 不能主动从同一麦克风波形分离人声和风扇/键盘/音乐 |
| AEC | 未发现 playback reference、adaptive echo canceller 或 WebRTC AEC | 无 | 外放中含清晰人声时，无法仅靠 AEC 不存在的代码消除回声；双讲尤其不能保证 |
| VAD | 有 Silero + smoothing | 删除被判为非语音的时间段，减少静音、部分稳态噪声进入 ASR | 外放语音也是语音，通常会通过 VAD；VAD 不是声源分离 |
| ASR 鲁棒性 | 取决于选择的 Nemotron/Whisper/SenseVoice 等模型 | 模型可能在噪声或混响中仍解出主讲者 | 模型卡只有笼统 challenging acoustic conditions，Handy/NVIDIA 都没有证明其能分离本机外放与用户双讲 |

Handy 还提供 `mute_while_recording`：打开后直接静音操作系统输出，结束时恢复之前的 mute 状态；默认值为 `false`。它能阻止本机扬声器继续播放，从源头减少回灌，但不是回声消除，且会破坏本项目“元元说话时用户可插话”的全双工目标。[实现](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/audio.rs#L554-L590)、[默认设置](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/settings.rs#L895-L936)

因此，试用观察最合理的表述是：**Handy 在那台设备、那种外放和那次内容下表现良好，但当前源码没有可迁移的 AEC 实现。** 若外放内容是音乐/环境音，Silero 删除非语音区间可能贡献较大；若外放是人声仍未转录，可能是模型、距离/声压、系统设备 DSP 或启用静音共同作用。必须通过 playback-only 与 double-talk 控制实验才能区分。

## 四、其它适合吸收的特性

| 优先级 | 特性 | 收益 | 复杂度 / 风险 | 适配建议 |
| --- | --- | --- | --- | --- |
| P0 | `committed + tentative + final` 流式文本契约 | 用户停说前即可看到字幕；稳定 prefix 不闪烁；可测 first partial/first stable latency | 中；partial 重写、取消和旧 generation 处理必须确定 | 只把 `committed` 用作稳定 UI；`tentative` 仅显示；只有 final-ASR 能进入 LLM/history/recap/Memory。Handy 契约见 [`transcription.rs` L60-L67](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L60-L67) |
| P0 | 能力驱动模型目录 + revision/hash/量化档 | 新 ASR 不再散落为 provider if/else；安装前可展示语言、streaming、LID、大小 | 中；目录元数据不能替代 runtime probe；许可证需逐模型审核 | 复用本项目 installer 的 marker-last/hash-lock/smoke，增加 `streaming/languages/events/timestamps/runtime` capability；运行时重新核对能力 |
| P0 | 模型下载断点续传、大小硬上限、SHA-256、取消 | 大模型安装失败可恢复，避免重复下载和 partial 被误用 | 中；Range/ETag、磁盘不足、取消竞态要覆盖 | 吸收机制，不复制 Handy 日志；保持 App-data staging、sibling swap、旧 runtime 回滚和固定 reason。Handy 参考：[`download.rs`](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/model/download.rs#L180-L358) |
| P1 | 麦克风与输入声道选择、真实首 sample readiness | 多麦克风/声卡用户可避开错误设备；“已录音”状态更可信 | 中；设备热插拔、名称隐私、跨平台重连 | 设置只持久化必要的 device identity，不进诊断；状态必须等真实首帧，不以 stream `play()` 成功代替 |
| P1 | 模型预热与闲置卸载 | 降低首轮 final/partial 延迟，同时控制常驻内存 | 中；与 Qwen TTS、VoxCPM、Silero/SenseVoice installer 的生命周期锁相互影响 | 沿用本项目 desired backend/fingerprint/epoch；卸载只能发生在无通话、无 TTS/ASR Future、无安装任务时 |
| P1 | 独立 ASR 自检与模型 A/B 入口 | 用户可在不启动完整通话时验证 mic/runtime/model | 中；不得保存或日志输出测试转录 | 固定 3--5 秒本地测试，默认不落盘；仅显示 fixed status、延迟、是否得到非空 final，文本由用户当场查看后销毁 |
| P2 | push-to-talk / hold-to-talk | 嘈杂环境中可显著减少误触发，利于桌面游戏场景 | 中；全局快捷键左右键/AltGr/权限和释放丢失已有平台风险 | 作为显式通话模式，不替换免手持模式；接入现有 background-call spec 的快捷键 fail-closed 设计 |
| P2 | fuzzy custom words / dictionary | 角色名、游戏名和专有名词更稳 | 中高；错误替换会篡改用户原话，中文 fuzzy 规则难 | 先做仅 final-ASR 的显式用户词表 A/B；不改 partial、不自动从 Memory 学词、不把外部 observation 写入词表 |

Handy 的流式 worker把早到帧排进标准 `mpsc::channel`，即无界队列；本项目的音频、TTS、VAD 和 ledger 明确要求有界，因此不能照搬。Handy 还会记录完整 `Transcription result`，而本项目诊断禁止完整 ASR/对话文本、PCM、路径和原始错误；其历史/录音保留能力也不能进入实时通话默认路径。[无界 stream channel 与 feed](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L121-L170)、[完整转录日志](https://github.com/cjpais/Handy/blob/af48dd68a64d58aad128fdbb920492a03da53c79/src-tauri/src/managers/transcription.rs#L1494-L1517)

## 五、建议的验证实验

### 5.1 先定义问题，不先接产品

要分别回答四个问题：

1. Nemotron 在本项目中文日常对话中，final CER 是否不劣于 SenseVoiceSmall？
2. Nemotron 是否能在 endpoint 前提供足够稳定、足够早的 partial？
3. 试用中的“抗外放”来自 ASR、VAD、采集端 AEC/NS，还是 Handy 的系统静音？
4. Nemotron runtime 是否能与本地 Qwen/VoxCPM TTS、WebView 和桌宠动画同时运行，而不造成内存、热量、GPU 争用或打断延迟回归？

### 5.2 固定实验矩阵

同一批 16 kHz mono PCM，在同一台设备上交叉测试：

- **ASR**：当前 SenseVoiceSmall INT8；Nemotron 官方 Q8；资源允许时加 Nemotron Q4_K_M；
- **语言**：Nemotron 固定 `zh-CN` 与 `auto` 分开，不把自动 LID 代价混入固定中文结果；
- **Nemotron chunk**：先测 160/320/560/1120 ms；80 ms 只有在 compute 与稳定性足够后保留；
- **VAD**：raw whole utterance；当前 RMS segment；Silero 只作为离线/旁路变量，不直接接管线上打断；
- **采集处理**：WebView AEC/NS/AGC 当前配置；能力允许时的 raw capture 对照；输出静音仅作诊断对照，不作为全双工方案；
- **声学场景**：安静近讲、风扇、键盘、纯外放音乐、纯外放中文人声、元元 TTS playback-only、用户 + 同时外放双讲、远讲/混响、普通话 + 粤语、中文夹英文专名；
- **短发言专项**：语气词、单字确认/否定、双字确认、立即开口与 300--500 ms 延迟开口；单独统计空 final、截断和替换，不能让长句平均 CER 掩盖短确认词失败；
- **设备**：至少一台 Apple Silicon macOS、一台 Windows RTX 5080/内置声卡；每台分别测内置扬声器、耳机和约 1 米外放。

每个 case 记录：final CER、删除/插入/替换率、playback-only 每分钟假转录字符与误确认次数、double-talk 用户词保留率、first tentative/first committed/final p50/p95、partial 回滚字符数、RTF、峰值 RSS/显存、CPU/GPU、温度降频、取消后释放时间。只保存许可范围内的聚合和 text-free 计时；不能把完整 ASR 或声学素材写入现有诊断 JSON。

第一阶段可以使用项目生成且有明确权利链的合成语料验证机械正确性；真人、房间回声和真实声音 A/B 必须先补足每个素材的权利、声音同意、派生、标注和人工审核记录。当前 `acoustic_manifest.py` schema v1 明确拒绝录音，不能为了这次比较绕过它。

### 5.3 Red -> Green 原型切片

1. **离线 adapter**：先写同一 PCM 输入下的 adapter 合约测试，覆盖空输入、超长输入、非法语言、runtime 缺失、取消、模型崩溃、旧 generation 丢弃；再接 NeMo-Speech.cpp sidecar。
2. **流式协议**：测试 `tentative` 可重写、`committed` 只能追加、final 收敛、断开/超时/取消不会把 partial 写入 history；输入队列必须有容量和明确 overflow 策略。
3. **资源与恢复**：模型冷启、热启、闲置卸载、通话中换设置、TTS 并发、hangup 后 blocking inference 延迟返回；旧 epoch 永远不能恢复成 active。
4. **真实 App E2E**：macOS 与 Windows 分别执行麦克风权限、内置扬声器双讲、耳机、设备切换、AudioContext suspend/resume 和打断恢复；未执行的平台必须明确标为未验收。

Go/no-go 不使用 Handy 的 `speed_score/accuracy_score`。建议至少要求：中文 final 的同语料置信区间不劣于当前 SenseVoiceSmall 的预先登记容差；first committed 明显早于当前 final 且回滚受控；playback-only/双讲不比当前 WebView AEC 路径差；峰值资源不挤占 TTS 实时性；取消和挂断恢复满足现有有界 Future/epoch 不变量。具体数字应在录制第一批合法 baseline 前预注册，避免看完结果后移动门槛。

## 六、不应直接照搬

- 不把 Handy 的 Silero VAD 称为 denoise 或 AEC，也不把 `mute_while_recording` 用于全双工通话。
- 不因 Nemotron 是原生 streaming 就让 partial 驱动 VAD、endpoint、barge-in、LLM、Memory 或 audible history。
- 不直接把 Handy 的无界 `mpsc` 音频队列带入本项目；所有音频/事件 admission、queue、ledger 和 generation 必须有界。
- 不在 Rust 主进程直接嵌入未经隔离压力测试的第三方 native runtime；先用 sidecar/C ABI 边界验证 crash、取消和卸载。
- 不把 Handy 目录中的 `accuracy_score=82`、`speed_score=84` 当作科研指标；它们是产品目录元数据。
- 不把英文 GGUF benchmark、H100 并发图或一次个人试用外推为中文、噪声和双讲结论。
- 不沿用 Handy 的完整转录日志、默认历史/录音保留或原始错误输出；继续遵守本项目 text-free 诊断和 Memory 隔离。
- 不静默失去 SenseVoice 的粤语、emotion/event 输出；若 Nemotron 成为可选 final/streaming ASR，能力协商必须明确这些字段为 unavailable 或由独立 adapter 提供。
- 不把模型权重塞进安装包。继续使用显式安装、固定 revision/filename/size/SHA-256/license/notice、真实 smoke、marker-last、可恢复 swap 和失败时原 provider 回退。

## 最终建议

近期最合理的工作不是“把 SenseVoice 换成 Nemotron”，而是建立一个 **可选的 Nemotron streaming ASR 实验 adapter**：优先通过官方 NeMo-Speech.cpp sidecar，在本地/CosyVoice 路径让 capability/诊断元数据保持 text-free，转录文本只通过受控的 `tentative/committed/final` 状态流转，并保持现有 RMS/VAD、candidate、endpoint、final safety、history 与 Memory 规则不变。

同时把 Handy 的“抗噪体验”作为声学实验线索，而不是实现方案：先完成 `ASR x VAD x AEC` 因子实验。若结果显示主要收益来自当前 WebView AEC/NS，就优化设备验收和采集链路；若来自 Nemotron 的 playback-only/double-talk 鲁棒性，再推进模型接入；若只来自 Handy 的静音输出，则该特性不适合元元的全双工通话目标。
