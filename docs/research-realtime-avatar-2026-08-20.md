# 实时通话虚拟形象 / 口型驱动开源方案调研（2026-08-20）

## 结论

**不建议把 SoulX-LiveAct 作为本项目第一条产品路线。** 它是 18B 级、面向连续生成的扩散视频系统：官方实时指标是双 H100/H200 在 720×416 或 512×512 下约 20 FPS；单 RTX 5090 配合 FP8 KV cache、CPU offload 时官方只报告约 6 FPS。RTX 5080 虽同属 Blackwell、可用 CUDA 12.8+/新 PyTorch，但只有 16 GB 显存，官方没有 5080 成功记录、显存峰值或可交互帧率，且仓库截至本调研日没有发布许可证文件。因此它更适合作为云端高质量实验，不适合当前桌面端本地实时通话。[SoulX-LiveAct README](https://github.com/Soul-AILab/SoulX-LiveAct/blob/main/README.md)；[官方论文](https://arxiv.org/abs/2603.11746)；[NVIDIA RTX 5080 规格](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5080/)；[PyTorch 2.7 Blackwell 支持](https://pytorch.org/blog/pytorch-2-7/)

对当前项目，建议把需求拆成两档：

1. **P0，跨 Windows/macOS 的产品路线：WebView 内 3D/2.5D 角色 + 音频流驱动 viseme/blendshape。** 首选评估 `TalkingHead + HeadAudio`，或沿用本项目宠物渲染方式增加一套角色口型/眨眼/呼吸状态机。它不生成逐帧照片级视频，但能直接消费现有 Worklet 的流式 PCM，官方实测音频到 viseme 约 50 ms，在 M2/16 GB 浏览器中运行，不依赖 CUDA，因此 RTX 5080 和 M4 48 GB 都能流畅运行。许可为 MIT。它最符合 Tauri WebView、本地隐私、barge-in、取消和低延迟要求。[TalkingHead README](https://github.com/met4citizen/TalkingHead/blob/main/README.md)；[HeadAudio README](https://github.com/met4citizen/HeadAudio/blob/main/README.md)；[HeadAudio LICENSE](https://github.com/met4citizen/HeadAudio/blob/main/LICENSE)
2. **P1，Windows RTX 5080 的照片级头像实验：MuseTalk 1.5 或 Ditto。** MuseTalk 是较成熟的“已有视频/待机循环 + 流式音频 → 局部口型”路线，官方在 V100 报告 30 FPS+，第三方集成框架 LiveTalking 在 RTX 4090 报告 72 FPS；Ditto 则能从单张图生成头部运动并有 online 配置，形象表现更完整。两者都没有官方 RTX 5080 结果，必须升级到 CUDA 12.8+/Blackwell 兼容运行时并实测。MuseTalk 的风险较低，Ditto 的 TensorRT 8.6/A100 基线需要更大移植工作。[MuseTalk README](https://github.com/TMElyralab/MuseTalk/blob/main/README.md)；[Ditto README](https://github.com/antgroup/ditto-talkinghead/blob/main/README.md)；[LiveTalking README](https://github.com/lipku/LiveTalking/blob/main/README-EN.md)
3. **M4 48 GB 上暂不承诺照片级 25 FPS。** LivePortrait 官方支持 Apple Silicon，但明确提示可能比 RTX 4090 慢 20 倍；MuseTalk 的社区 Apple Silicon 端口在其测试机上生成 8 秒视频约需 17 秒，尚未实现首帧小于 1 秒的流式输出；OpenTalking 的 QuickTalk 官方 Apple Silicon 文档建议降到 14 FPS，并明确稳定 25 FPS 应使用 Linux CUDA。M4 48 GB 容量通常足够装载这些较小模型，但公开资料不足以证明其实时吞吐达标。[LivePortrait README](https://github.com/KwaiVGI/LivePortrait/blob/main/readme.md)；[MuseTalk Mac README](https://github.com/barnent1/musetalk-mac/blob/main/README.md)；[QuickTalk on Apple Silicon](https://github.com/datascale-ai/opentalking/blob/main/docs/en/model-deployment/quicktalk/apple-silicon.md)

## 评估口径

本项目的“实时”不能只看离线视频平均 FPS。至少要同时满足：

- 能持续接收当前本地/CosyVoice/Volcano 下行 PCM，而不是必须等待完整 WAV。
- 首个可见口型最好不晚于首个可听音频 100--200 ms；持续渲染至少 20--25 FPS。
- 候选说话、确认打断、挂断或 generation 变化时，可以立即取消旧帧，不把旧回复继续播放。
- GPU/统一内存占用有上限，不挤占现有 TTS、ASR、WebView 与系统图形内存。
- 模型、代码和示例角色资产的许可证都允许目标分发方式。
- 不把音频、角色图、persona 或 Memory 发送到外部服务。

“输入音频文件后生成 MP4”不等于流式。下表把项目官方明确提供的 online/chunk/stream 接口与只能离线调用的路径分开。

## 主要候选对比

| 方案 | 驱动与输出 | 官方流式/实时证据 | RTX 5080 | Apple Silicon M4 48 GB | 许可证 | 对本项目判断 |
| --- | --- | --- | --- | --- | --- | --- |
| **SoulX-LiveAct** | 单图 + 音频 + 可选动作/情绪控制；生成完整人物视频 | 双 H100/H200 约 20 FPS；单 RTX 5090 的 18B 模型约 6 FPS；支持 streaming audio、长时恒定记忆 | **未确认。** Blackwell 软件栈可行，但 5080 仅 16 GB，官方只点名 4090/5090，未公布显存峰值 | **不支持。** CUDA/vLLM/SageAttention 路线，无 MPS/MLX 路径 | 仓库未发现 LICENSE；不能推定可复制、修改或随 App 分发 | 排除本地产品首选；只做隔离云端/研究实验 |
| **LivePortrait** | 单图/视频 + 驱动视频或 motion template；整脸表情、头动、眨眼，不原生从音频提取口型 | RTX 4090 单帧核心模块合计约 14.8 ms；官方代码主要是离线 pipeline，没有音频流会话协议 | **大概率可移植，未确认。** 应换 cu128 PyTorch；官方还提示 Windows 高 CUDA 版本可能有问题 | 官方支持 humans mode，但称可能比 4090 慢 20 倍；animals mode 不支持 | MIT；仍需核对模型及人脸检测依赖 | 适合做渲染器/动作模板，不是独立的语音口型方案 |
| **MuseTalk 1.5** | 视频或待机帧序列 + 音频；只重绘 256×256 脸部区域 | 官方提供 realtime inference；V100 30 FPS+；需先为每个 avatar preparation，之后消费 audio clips | **最值得实测。** 官方旧环境 CUDA 11.7/torch 2.0.1 不支持 5080，需迁移到 cu128；16 GB 是否足够实时需本机测 | 上游未支持；社区 Mac 端口支持 M1--M4，但公开结果约 17 秒生成 8 秒，当前不是实时流 | 代码 MIT；README 称训练模型可商用；第三方模型分别审计 | Windows P0 照片级口型候选；macOS 不达标 |
| **Wav2Lip** | 任意视频/单图 + 完整音频；局部嘴部重绘 | 官方仓库是离线 MP4 流程，没有官方长连接音频流协议；LiveTalking 做了实时适配并报告 RTX 3060 60 FPS | **计算上可行，产品许可阻断。** 老依赖需 cu128 移植 | 官方无 Apple Silicon/MPS 路径 | 开源模型仅个人/研究/非商用；商业使用被明确禁止 | 仅作基线，不合入默认产品 |
| **SadTalker** | 单张肖像 + 完整音频；生成头部姿态和表情视频 | 官方命令接受 `audio.wav` 并输出视频；没有实时/流式保证，论文路线偏离线生成 | 可能运行，但官方仍示例 torch 1.12/cu113；没有 5080 性能数据 | 有 macOS 安装说明，但无 M4 性能、MPS 实时数据 | Apache-2.0，第三方组件另计 | 离线头像生成可用，不适合实时通话主链路 |
| **Ditto** | 单图 + 音频；音频直接生成 motion，再由 LivePortrait 类 renderer 出图 | 名称和论文定位为 realtime；仓库提供 `v0.4_hubert_cfg_trt_online.pkl` 和 streaming HuBERT ONNX，但 README 示例仍以完整音频输出 MP4 为主 | **有希望但未确认。** 官方只测 A100 + TensorRT 8.6；预编译 engine 是 Ampere_Plus。5080 应重建 TensorRT engine，并升级 Blackwell 运行时 | 无官方 macOS/MPS 路径；PyTorch 模型发布不等于已支持 M4 | Apache-2.0 | Windows P1；画面能力优于纯口型，但适配成本高于 MuseTalk |
| **FasterLivePortrait + JoyVASA** | LivePortrait TensorRT renderer；JoyVASA 可用音频生成头动/表情 | FasterLivePortrait 在 RTX 3090 报告端到端单帧 30 FPS+，JoyVASA 支持音频驱动；但 JoyVASA 官方仍把“改进实时性能”列为 future work | **未确认。** 现有 TensorRT 8.x、自编译 grid-sample 和固定旧架构列表都要为 sm_120 重做 | 有 requirements_macos，但 TensorRT 主路径不可用；没有 M4 实时数据 | FasterLivePortrait MIT；模型分别遵守上游许可 | 可借鉴 renderer，不建议直接承担双平台产品后端 |
| **AVTR-1** | 单图 + 双路音频；能同时生成说话和主动聆听动作 | 25 FPS、5 帧/200 ms 一块；RTX 4060 Ti 166 ms、3070 181 ms；提供 interactive streaming demo | 性能上很可能足够，但官方要求 Linux、CUDA 12.x、TensorRT 10.x，未明确 Windows/5080 | 不支持 | renderer/streamer 为 PolyForm Noncommercial；还有 InsightFace 非商用依赖 | 技术形态很匹配，但许可证和平台排除当前产品 |
| **OpenTalking QuickTalk** | 单图 + 音频的实时数字人，提供 WebRTC/流式框架 | 官方 CUDA 路线目标 25 FPS；Apple Silicon 文档可用 MPS，本地建议 14 FPS | 项目依赖范围允许新 PyTorch，`quicktalk-cuda` 使用新版 ONNX Runtime GPU；但没有 5080 FPS/显存数字 | 可运行，官方明确不是稳定 25 FPS 生产目标 | Apache-2.0；各模型/资产另计 | 很好的集成参考或独立 sidecar，M4 只适合降帧实验 |
| **TalkingHead + HeadAudio** | GLB/VRM 类 3D 角色；浏览器 PCM 实时分类为 Oculus viseme，驱动 blendshape | HeadAudio 全浏览器 AudioWorklet，官方实测约 50 ms 端到端；TalkingHead 支持 PCM chunks、`streamStart/streamAudio/streamInterrupt` | 不依赖 NVIDIA；直接可用 | 官方在 M2/16 GB Chrome 测试，且支持 Safari/iOS；M4 48 GB 无硬件压力 | 两者 MIT；示例 avatar 资产许可不一，必须换成自有角色 | **双平台首选**；不是照片级生成，但最符合桌宠和实时通话工程约束 |

## 逐项分析

### SoulX-LiveAct

SoulX 的优势是它真正解决了“长时间连续生成完整角色视频”，而不是只修嘴。ConvKV Memory 使长时生成内存不随时长线性增长，并支持音频、动作和情绪控制。代价是模型为 14B Wan2.1 + 4B audio module，官方消费卡优化仍需 FP8 KV cache、block offload 和 T5 CPU；在更强且显存更大的 RTX 5090 上也只有约 6 FPS。因此，RTX 5080 即使能成功加载，也不能根据“同为 Blackwell”推断可达实时。[官方 README](https://github.com/Soul-AILab/SoulX-LiveAct/blob/main/README.md)

RTX 5080 本身是 16 GB Blackwell GPU；PyTorch 从 2.7/cu128 起提供 Blackwell 支持，这只证明基础算子运行时具备兼容路径，不证明 SoulX 的 vLLM、SageAttention、FP4 自定义 kernel、offload 峰值内存和性能都已覆盖 5080。产品判断应保持 `unsupported/not-validated`，直到完成真实加载、连续 30 分钟和取消测试。[NVIDIA 官方规格](https://marketplace.nvidia.com/en-us/consumer/graphics-cards/geforce-rtx-5080/)；[PyTorch 2.7 release](https://pytorch.org/blog/pytorch-2-7/)

此外，官方仓库根目录没有 LICENSE，README 也没有授予代码或权重使用权。公开可访问不等于开源授权；在作者补充明确许可证前，不应复制代码、打包权重或把它列为可分发产品依赖。

### LivePortrait

LivePortrait 是高效 portrait warping renderer。官方 RTX 4090 `torch.compile` 单帧表中，appearance、motion、generator、warping 和 stitching/retargeting 模块合计约 14.77 ms；其中静态 source 的 appearance 特征可缓存，所以工程化后有充分实时潜力。[官方 speed 表](https://github.com/KwaiVGI/LivePortrait/blob/main/assets/docs/speed.md)

但它的原生驱动是视频、图像或 motion template，不是音频。要用于本项目，仍需 MuseTalk、Ditto、JoyVASA、音频到 blendshape 模型，或自行做 viseme/动作映射。macOS 官方路径可运行 humans mode，但明确警告可能比 RTX 4090 慢 20 倍，且 `torch.compile` 加速不支持 Windows/macOS。因此它更适合成为共享 renderer，而不是直接宣称“双平台实时音频头像”。[官方 README](https://github.com/KwaiVGI/LivePortrait/blob/main/readme.md)

### MuseTalk

MuseTalk 的工程形态最接近当前需求：先对固定角色视频做 preparation，缓存脸部坐标/latent，通话时把新音频切片变成 Whisper 特征并只重绘脸区。对桌面宠物而言，可以准备 5--15 秒无缝待机循环，而不必生成整个人体和背景。官方提供 Linux/Windows realtime 命令，V100 报告 30 FPS+，并建议角色视频使用训练时一致的 25 FPS。[官方 README](https://github.com/TMElyralab/MuseTalk/blob/main/README.md)

主要问题是官方环境停在 CUDA 11.7/11.8 和 PyTorch 2.0.1，不能直接支持 RTX 5080 的 sm_120。实验时必须使用 cu128 版 PyTorch，逐个处理 xformers、OpenMMLab、face parsing 和 fp16 行为，不可只改一行 torch 版本。官方“4 GB VRAM 可运行”的数据是 8 秒视频约 5 分钟，不代表实时；5080 是否能在 16 GB 内达到稳定 25 FPS 需要实测。

Apple Silicon 社区端口 `musetalk-mac` 是独立项目的一手资料，不代表 MuseTalk 上游支持。它支持 M1--M4、MPS 和本地 server，但发布者自己的端到端数字是 8 秒音频约 17 秒，流式首帧小于 1 秒仍列在未来计划。因此可作为 M4 可运行性参考，不能作为本项目实时承诺。[MuseTalk Mac README](https://github.com/barnent1/musetalk-mac/blob/main/README.md)

### Wav2Lip

Wav2Lip 仍是口型同步基线，输入已有视频和音频，适合验证角色素材的嘴部可动性。其官方仓库只提供完整文件推理；LiveTalking 等框架通过预处理帧、缓存检测和 WebRTC 输出把它改造成实时服务，并报告 RTX 3060 上 wav2lip256 约 60 FPS。[Wav2Lip README](https://github.com/Rudrabha/Wav2Lip/blob/master/README.md)；[LiveTalking README](https://github.com/lipku/LiveTalking/blob/main/README-EN.md)

决定性问题是许可证：官方明确说明开源模型因训练数据限制只能用于研究、学术和个人非商业用途，商业使用严格禁止。即使 kxyy 当前是个人项目，也不应把它作为未来可发布/可商业化的默认技术基础。

### SadTalker

SadTalker 从单图和完整音频生成 3D motion coefficients，再合成带头动的视频；许可证已改为 Apache-2.0，也提供 macOS 安装说明。但官方流程仍是 `--driven_audio audio.wav` 后输出文件，没有在线音频窗口、逐块帧时钟、回压或中断协议。它适合“生成角色介绍视频”或离线素材，不适合直接挂到本项目现有 80 ms PCM chunk 和 barge-in 生命周期上。[SadTalker README](https://github.com/OpenTalker/SadTalker/blob/main/README.md)；[LICENSE](https://github.com/OpenTalker/SadTalker/blob/main/LICENSE)

### Ditto

Ditto 比 MuseTalk 更像“单图实时会动的角色”：音频经 streaming HuBERT 和 motion-space diffusion 生成动作，再通过 LivePortrait 类网络渲染；官方仓库同时提供 online config、ONNX、TensorRT engine 和 PyTorch 模型。Apache-2.0 也比 Wav2Lip 清晰。[Ditto README](https://github.com/antgroup/ditto-talkinghead/blob/main/README.md)；[官方论文](https://arxiv.org/abs/2411.19509)

不过官方唯一明确测试环境是 CentOS 7.2、A100、TensorRT 8.6.1。预制 engine 使用 `Ampere_Plus` compatibility，不能把它等同于 Blackwell 已验证；RTX 5080 应从 ONNX 在本机用新 TensorRT 重建，并检查自定义 3D grid-sample plugin。官方没有 VRAM、FPS、Windows 或 macOS 数据。因此 Ditto 值得作为 Windows P1，但不应先于 MuseTalk。

### 更合适的候选

#### TalkingHead + HeadAudio：最符合当前产品，而非最照片级

TalkingHead 是 Three.js 实时 3D 角色类，`speakAudio` 可接 AudioBuffer 或 PCM chunks；高级 streaming API 包含 `streamStart`、`streamAudio`、`streamInterrupt`、`streamStop`。HeadAudio 直接运行在 AudioWorklet 中，从任意语音流生成 Oculus viseme blendshape，不需要转写或单词时间戳；官方在 MacBook Air M2/16 GB 上报告约 50 ms 端到端处理延迟。[TalkingHead streaming API](https://github.com/met4citizen/TalkingHead/blob/main/README.md#appendix-g-streaming-audio-and-lip-sync-advanced)；[HeadAudio performance](https://github.com/met4citizen/HeadAudio/blob/main/README.md)

这条路线可以直接接到本项目 `playback-worklet.js` 的**同一份已接受、当前 generation 的 PCM**，天然跟随暂停、候选说话、clear 和完成回执，不需要再建立视频编码/解码/WebRTC 链。缺点是必须准备带 viseme/ARKit morph targets 的 3D 角色，视觉风格不是“由一张立绘实时生成照片级视频”；HeadAudio 也明确承认纯音频 viseme 精度有限。对元元这种已有二次元角色资产的项目，工程收益仍明显高于扩散视频。

#### AVTR-1：技术上贴题，许可证不贴题

AVTR-1 同时输入角色语音和对方语音，可在角色说话时做口型，在用户说话时生成 active listening；其 5 帧 chunk 在 RTX 4060 Ti 上 166 ms，公开数据说明中端卡已能维持 25 FPS。这个交互模型非常适合实时通话。[AVTR-1 README](https://github.com/avaturn-live/avtr-1/blob/main/README.md)

但当前 renderer 和 streamer 是 PolyForm Noncommercial，且依赖的 InsightFace 预训练检测器也是非商用研究限制；平台要求 Linux + NVIDIA + TensorRT 10.x。因此只能作为产品设计参考，不能成为默认可分发实现。

#### OpenTalking / QuickTalk：可借鉴 sidecar 与 WebRTC 边界

OpenTalking 是完整实时数字人框架，包含模型 adapter、音频到视频、帧时钟、WebRTC 和多种后端。它比直接嵌入某个研究仓库更接近本项目需要的 sidecar 形状。其当前文档已经给 Apple Silicon QuickTalk 路径，但建议 14 FPS，并明确稳定实时 25 FPS 使用 Linux CUDA；Windows/5080 仍没有公开验收数字。[OpenTalking support matrix](https://github.com/datascale-ai/opentalking/blob/main/docs/en/avatar_models/support-matrix.md)；[Apple Silicon 文档](https://github.com/datascale-ai/opentalking/blob/main/docs/en/model-deployment/quicktalk/apple-silicon.md)

若未来必须输出照片级视频，建议参考它的 adapter/clock/WebRTC 分层，而不是把其整套 LLM/TTS/persona 系统并入本项目。

## 推荐集成架构

### P0：WebView 原生虚拟形象

1. 在 `chat` 通话 UI 增加 avatar canvas；不要替换现有 252×64 capsule，先新增可选的较大通话窗口模式。
2. 让 `playback-worklet.js` 或其主线程桥接在**音频实际入队并被当前 generation 接受后**，复制一份 Float32/PCM 特征输入给 lip-sync Worklet。不要从 Python “计划播放”的文本或 PCM 推断口型。
3. 输出固定 allow-list 的 15 个 Oculus viseme 或项目自定义 6--10 个嘴型，再由角色 renderer 做平滑、眨眼、呼吸、视线和情绪动作。
4. candidate 时暂停音频消费的同时冻结/回落嘴型；confirmed、clear、generation change、hangup 时立即归零，不等待动画队列自然耗尽。
5. 角色资产必须是自制或获得可分发授权的 GLB/VRM；不要打包 TalkingHead README 中许可证各异的示例 avatar。

这一路径能同时覆盖 RTX 5080 与 M4，且不会新增 Python/CUDA 安装器、数 GB 权重、视频编解码和 WebRTC 生命周期。

### P1：Windows MuseTalk sidecar

1. 固定角色离线 preparation：输入一段 25 FPS、正脸、肩部动作小、可无缝循环的元元待机视频；缓存 bbox、mask、VAE latent 和 frame ring。
2. sidecar 只接收本项目已经完成 generation/segment 校验的 16/24 kHz PCM，内部重采样并按固定音频窗口生成 25 FPS RGBA/JPEG/WebP 帧；不要让它拥有 LLM、TTS 或历史。
3. 初版用 loopback WebSocket 发送带 `generation + frameSeq + mediaTimeSamples` 的帧；WebView 按播放采样时钟选帧。若压缩开销过高，再评估共享内存或本地 WebRTC。
4. 每个队列必须有固定上限。视频推理落后时丢弃旧视频帧，不得拖慢音频；头像最多降级为静态/简单嘴型。
5. 单独建立 cu128 venv；启动时检查 `torch.cuda.get_arch_list()` 包含 `sm_120`，执行真实 VAE/UNet CUDA smoke，而非只检查 `torch.cuda.is_available()`。

### P2：Ditto 单图头像

只有当 MuseTalk 的“循环视频身份稳定性/嘴部边缘”不能接受时，再测试 Ditto。先在 RTX 5080 上完成 ONNX → 新 TensorRT engine 的隔离构建，记录：

- 模型与 plugin 的精确版本；
- 冷启动/热启动、首帧和 5 帧 chunk p50/p95；
- 峰值显存与连续 30 分钟增长；
- 音频中断后过期帧清空时间；
- 中文短音节、静音、笑声和快速语速的口型；
- 单图二次元角色是否出现身份漂移或牙齿/脸缘伪影。

不要同时引入 Ditto 的 PyTorch 和 TensorRT 两条生产路径；实验胜出后再固定一种。

## 验收门槛

任何照片级方案合入前，至少通过：

- RTX 5080：PyTorch/CUDA 12.8+、`sm_120`、真实 kernel smoke；25 FPS 输出 p95 不低于实时，峰值显存留出 TTS/ASR 与桌面合成余量。
- M4 48 GB：连续 30 分钟平均不低于目标 FPS，首帧、统一内存、thermal throttling、系统 swap 均记录；不能以“能加载”为通过。
- 端到端：可听音频与嘴型偏差绝对值 p95 ≤ 120 ms；barge-in 后 150 ms 内嘴型回落且不显示旧 generation。
- 降级：头像后端崩溃、卡住或跟不上时，音频通话继续；UI 回退静态头像/简单 viseme，不关闭 realtime session。
- 资源：安装器不默认捆绑未经许可的人脸模型、示例头像或数 GB 权重；下载物有固定版本、哈希、许可和卸载路径。
- 隐私：诊断只记录固定枚举、帧率、队列和延迟，不记录角色图、视频帧、PCM、文本、人脸 embedding 或本地路径。

## 最终推荐

**近期产品实现：选择“WebView 角色渲染 + HeadAudio/自研轻量 viseme”，不要选择扩散视频。** 它是唯一同时满足 Windows RTX 5080、MacBook Pro M4 48 GB、流式 PCM、快速打断、低安装成本和宽松许可的路线。

**照片级 Windows 实验顺序：MuseTalk 1.5 → Ditto。** MuseTalk 更容易把现有元元待机视频变成稳定口型；Ditto 在单图头动和表情上更完整，但 TensorRT/Blackwell 移植风险更高。

**macOS 照片级路线暂缓。** 当前官方/项目一手数据中，没有候选在 Apple Silicon 上证明稳定 25 FPS：LivePortrait 官方警告可能慢 20 倍，MuseTalk Mac 约 0.47× realtime，QuickTalk 建议 14 FPS。可以做 12--15 FPS 独立原型，但不能作为与 Windows 等价的产品能力。

**SoulX-LiveAct 不进入本地候选。** 即使未来 RTX 5080 能通过 offload 加载，RTX 5090 官方约 6 FPS 已说明它不符合当前交互目标；无明确许可证又增加了分发阻断。

## 主要一手来源

- [SoulX-LiveAct 官方仓库](https://github.com/Soul-AILab/SoulX-LiveAct)
- [SoulX-LiveAct 论文](https://arxiv.org/abs/2603.11746)
- [LivePortrait 官方仓库](https://github.com/KwaiVGI/LivePortrait)
- [LivePortrait 官方 speed 表](https://github.com/KwaiVGI/LivePortrait/blob/main/assets/docs/speed.md)
- [MuseTalk 官方仓库](https://github.com/TMElyralab/MuseTalk)
- [MuseTalk 技术报告](https://arxiv.org/abs/2410.10122)
- [Wav2Lip 官方仓库](https://github.com/Rudrabha/Wav2Lip)
- [Wav2Lip 论文](https://arxiv.org/abs/2008.10010)
- [SadTalker 官方仓库](https://github.com/OpenTalker/SadTalker)
- [SadTalker 论文](https://arxiv.org/abs/2211.12194)
- [Ditto 官方仓库](https://github.com/antgroup/ditto-talkinghead)
- [Ditto 论文](https://arxiv.org/abs/2411.19509)
- [FasterLivePortrait 官方仓库](https://github.com/warmshao/FasterLivePortrait)
- [JoyVASA 官方仓库](https://github.com/jdh-algo/JoyVASA)
- [AVTR-1 官方仓库](https://github.com/avaturn-live/avtr-1)
- [OpenTalking 官方仓库](https://github.com/datascale-ai/opentalking)
- [LiveTalking 官方仓库](https://github.com/lipku/LiveTalking)
- [TalkingHead 官方仓库](https://github.com/met4citizen/TalkingHead)
- [HeadAudio 官方仓库](https://github.com/met4citizen/HeadAudio)
- [NVIDIA RTX 5080 官方规格](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5080/)
- [PyTorch 2.7 Blackwell 官方发布说明](https://pytorch.org/blog/pytorch-2-7/)
