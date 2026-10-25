# 实时对话语音模型更新调研（2026-10-05）

## 结论

1. **没有 VoxCPM3；VoxCPM2 仍是官方最新主版本。** PyPI 最新版是 `voxcpm 2.0.3`（2026-05-11），官方仓库截至 2026-09-30 仍在维护，但项目当前固定的上游 commit `616d3d3`（2026-07-08）之后，推理核心没有出现能解决本项目实时连续性问题的新版本。后续主要是 Docker、文档、时间戳、训练预处理和安全修复。[PyPI release history](https://pypi.org/project/voxcpm/)；[官方仓库当前 HEAD](https://github.com/OpenBMB/VoxCPM/commit/f0c787f0937dc1c9a8f4f64d9a332d9c5da2e629)；[项目 Windows setup 固定版本](../scripts/voxcpm-ab/setup.ps1)；[macOS setup 固定版本](../scripts/macos/setup-voxcpm2.sh)
2. **项目使用的已经是当前这代 VoxCPM2，不是旧的 0.5B VoxCPM。** 它是 2B、48 kHz、30 语言、约 8 GB VRAM，支持 Ultimate Cloning、可控克隆和真实逐块 `generate_streaming()`；官方标准 PyTorch 路径在 RTX 4090 报告 RTF 约 0.30，Nano-vLLM 约 0.13。项目已做 prompt cache，并在 RTX 5080 上把实时路径调到 6 diffusion steps，实测 TTFA 约 169 ms、RTF 约 0.94；这些项目数据不能外推到别的设备。[官方 README](https://github.com/OpenBMB/VoxCPM/blob/f0c787f0937dc1c9a8f4f64d9a332d9c5da2e629/README.md#-models--versions)；[项目实时路线图](./roadmap-realtime-voice.md#windows-voxcpm2-流式连续性2026-08-20)
3. **目前没有一个新模型可以仅凭公开资料直接判定为“全面优于 VoxCPM2 且可替换”。** 最值得在当前硬件上做下一轮 A/B 的顺序是：
   - **P0：dots.tts MF 2-step**，CUDA 路径与本项目最同形，Apache-2.0、原生音频流式、公开中文音色指标略高于 VoxCPM2；项目已经有完整接入调研。
   - **P0：本地 CosyVoice3 0.5B**，若目标是更低延迟、稳定 instruction 和更轻量的本地运行，它比“再找一个大模型”更有工程价值；但声纹相似度未公开胜过 VoxCPM2，且 macOS 官方路径仍弱。
   - **P1：IndexTTS-2.5**，音色/情绪/发音控制值得离线盲听，但没有官方真流式输出，现阶段不能承担实时默认。
   - **观察：LongCat-AudioDiT 1B/3.5B**，公开声纹指标很强、MIT，但当前接口是整段非自回归扩散生成，需要预估 duration，没有 provider streaming 证据。
   - **不进入产品候选：Fish Audio S2 Pro、VibeVoice Realtime。** Fish S2 在质量和流式性能上很强，但权重只允许研究/非商业使用，商业/产品使用需单独许可，且 100 ms TTFA 来自 H200；VibeVoice Realtime 是 English-only、音色指标弱于 VoxCPM2，并会强制加入可听 AI 声明。
4. **推荐动作不是立即换默认，而是先用固定 revision 重新基准当前 VoxCPM2，再跑 dots.tts 与本地 CosyVoice3 同机 A/B。** 当前安装脚本固定源码 commit，但模型下载没有固定 Hugging Face revision 或文件 hash；在比较新模型前应先消除这项可复现性缺口。

## 本项目的判定标准

“更好”不能只看 MOS、WER/CER 或供应方 demo。当前实时链路要求候选同时满足：

- 中文短句和中英混合可靠，元元参考音的**最低相似度和离群率**可接受，而不只是平均 SIM 高；
- provider 原生逐块生成，目标设备 `RTF p95 < 0.8` 较稳妥，至少必须 `< 1.0`，且首个可播放 PCM 足够早；
- 单次 `next()` 有界、取消后能恢复，旧 generation 不会继续出声；
- 能保持现有单 lane、无 next prefetch、24 kHz PCM、最多 80 ms chunk、`KXAU` generation/segment/sequence 和 audible-history completion receipt；
- Windows RTX 5080 的 cu128/`sm_120` 可运行；macOS 若要列为跨平台默认，必须有可审计且实测达标的 Apple Silicon 路径；
- 许可允许当前桌面应用的使用和分发，依赖、权重与安装过程能锁版本/hash；
- 100 次生成无崩溃、无显存持续增长、无异常长音或取消后残音。

供应方在 H200/H800/4090 上的平均值只用于决定是否值得测试，不是上述验收的替代品。

## VoxCPM2 更新核查

### 当前上游状态

| 项目 | 已核实状态 | 对 kxyy 的意义 |
|---|---|---|
| 最新模型 | VoxCPM2，2B，48 kHz，30 语言，2026-04 发布 | 项目已使用同一代 `openbmb/VoxCPM2`，不是有新大版本漏接 |
| Python 包 | `2.0.3`，2026-05-11 发布 | 当前两个 setup 从 git commit 安装而非按 PyPI 版本；固定 commit 比 2.0.3 更新 |
| 上游代码 | HEAD `f0c787f`，2026-09-30 | `616d3d3..HEAD` 未出现新的推理加速或流式协议改造 |
| 模型仓库 | HF revision `32279eff`，最后更新 2026-08-18 | 项目 setup 下载浮动 `main`，没有 revision/hash lock；重装结果可能变化 |
| 标准流式 | `generate_streaming()` | 项目已经使用，并用 prompt cache、48→24 kHz 有状态重采样接入现有协议 |
| CUDA 加速 | Nano-vLLM 约 0.13 RTF；vLLM-Omni 提供 streaming/OpenAI-compatible serving | 更偏服务器吞吐；引入服务运行时并不能自动改善本项目单请求音色或取消边界 |
| Apple Silicon | 官方 Python app 支持 `mps`；llama.cpp-omni 支持 Metal | Python MPS 项目已接；官方给出的 llama.cpp-omni M4 Pro Q8 RTF 约 1.76，不适合实时播放 |

来源：[VoxCPM README](https://github.com/OpenBMB/VoxCPM/blob/f0c787f0937dc1c9a8f4f64d9a332d9c5da2e629/README.md)、[PyPI JSON](https://pypi.org/pypi/voxcpm/json)、[HF model card](https://huggingface.co/openbmb/VoxCPM2)、[当前 adapter](../scripts/local-realtime/server_voxcpm.py)。

### 这次更新没有解决什么

- 上游仍明确提示 style control 会跨次变化，长文本或强表现输入偶有不稳定；固定 seed 只能提高复现性，不能证明没有异常持续音或身份漂移。[官方模型卡 Limitations](https://huggingface.co/openbmb/VoxCPM2#limitations)
- 官方约 0.30/0.13 RTF 是 RTX 4090 路径，不等于 macOS、RTX 5080 + 当前 Python adapter 或 6-step 质量边界。
- vLLM/Nano-vLLM 面向吞吐和服务化；本项目最难的约束是句级单 lane、及时取消、候选暂停、播放回执和参考音稳定性，不能只因服务器 TTFA 更低就直接替换现有 generator。
- `llama.cpp-omni` 的跨平台性值得跟踪，但官方列出的 M4 Pro Q8 RTF 约 1.76 已慢于实时，且 GGUF 来自生态仓库，不是 `openbmb/VoxCPM2` 官方权重发布物。

### 应先做的 VoxCPM2 基线刷新

1. 固定代码 `f0c787f` 或明确 tag、HF revision `32279eff` 与所有大文件 SHA-256，建立新的 runtime marker；不能继续下载浮动 `main` 后写“已复现”。
2. 在隔离 venv 复跑现有参考音缓存、固定 seed、10/8/6 steps；Windows 至少测 20 条 × 10 次、取消恢复和 100 次 soak。旧环境保持不动，结果不达标即可删除新实验环境。
3. Mac 继续测官方 MPS FP32，不因 README 新增 `mps` 选项就视为性能升级；记录 TTFA、每 chunk wall time、RTF、内存、句间 `audibleGapMs`。
4. 除非同机证明 Nano-vLLM/vLLM-Omni 能保持 Ultimate Cloning、prompt cache、固定 seed、逐 generation 取消和单请求低延迟，否则不扩大产品运行时。

## 候选比较

| 候选 | 相对 VoxCPM2 的公开优势 | 实时/平台/许可边界 | 判断 |
|---|---|---|---|
| **dots.tts MF 2-step / STTS 2B** | dots 团队同表 Seed-ZH：SOAR SIM 81.0、CER 0.94；VoxCPM2 79.5/0.97。MF 官方 `generate_stream()`；H800 MF clone first-chunk p50 204 ms、RTF p50 0.15；Apache-2.0 | 官方 runtime 只有 CUDA/CPU，无 MPS；STTS 的 text-token/audio 双流与当前 SSE 字符 delta 不同形；目标 RTX 5080 未测 | **P0 CUDA A/B。** 先测 MF 普通音频流式，胜出后才讨论 STTS；详见[既有调研](./research-dots-tts.md) |
| **Fun-CosyVoice3 0.5B-2512** | 0.5B、双向流式、官方称最低约 150 ms；支持中文、跨语种克隆、emotion/speed/volume/dialect instruction；Apache-2.0 | 官方表 Seed-ZH base SIM 78.0、CER 1.21，未胜 VoxCPM2；主要官方安装是 CUDA/Linux 形状，Mac MLX 属社区路径 | **P0 本地轻量候选。** 价值在延迟、可控性和资源占用，不应宣称音色质量已胜出 |
| **IndexTTS-2.5** | 约 0.8B GPT、约 6 GB VRAM；中文/英文/日/西/阿；音色与 8 维情绪解耦，支持语速和拼音/音素控制；近期还在优化参考音缓存开销 | 官方公开 API 写完整 output file；长文本切段后拼静音，没有逐 PCM generator；自定义 Bilibili license，超过 1 亿 MAU 或年收入 10 亿元需另行授权 | **P1 离线 A/B。** 适合验证情绪和发音，不满足当前真流式门槛 |
| **LongCat-AudioDiT 1B/3.5B** | MIT；官方表 3.5B Seed-ZH SIM 81.8、hard SIM 79.7，1B 也有 81.2/78.7，均高于 VoxCPM2 表中 79.5/75.3 | 当前 API 要完整文本、预设 duration、16 diffusion steps 后返回 waveform；无官方 streaming、TTFA/RTF/取消数据，CUDA-only 示例 | **观察。** 指标适合离线质量上界，不适合作为下一位实时 adapter |
| **Fish Audio S2 Pro 4B** | Seed-ZH CER 0.54；自由内联情绪控制；SGLang 在单 H200 报告 TTFA 约 100 ms、RTF 0.195 | 4B + 400M fast AR，桌面卡未知；模型卡明确免费仅研究/非商业，产品/商业使用要另签；Mac 仅社区转换 | **不进入产品 P0。** 可做非商业研究基准，但许可和硬件证据均不适合作为当前替换 |
| **VibeVoice-Realtime 0.5B** | 真正 streaming text input，约 300 ms 首音，MIT，轻量 | 官方明确 English-only；Seed-EN SIM 0.633，远低于 VoxCPM2 0.753；自动加入可听 AI 声明；不建议真实产品使用 | **排除。** 与中文角色克隆和沉浸式连续对话目标冲突 |
| **Higgs Audio v3 4B** | 丰富 style/emotion 控制 | 本项目已实测 RTF 中位约 1.29、片段间 2--3 秒空隙、异常拖音；许可也阻断产品接入 | **保持退役。** 不因新一轮模型搜索恢复，详见[历史负面实验](./research-higgs-tts-3-4b-macos-2026-08-10.md) |

补充边界：上表的 benchmark 来自各供应方自己的模型卡/论文，测试协议未必完全一致。LongCat 的表把旧 VoxCPM 0.5B 而非 VoxCPM2 作为行名；dots.tts 与 VoxCPM2 README 中的同表比较相对更可参考，但仍不能替代项目参考音的同机盲测。

## 推荐实验顺序

### A. 先刷新 VoxCPM2（低成本，最高信息增益）

- 新建隔离 runtime，不改设置项或默认后端；固定源码、权重 revision/hash。
- 复用现有 `ref.wav/ref.txt`、固定语料和 `evaluate_qwen_streaming.py` 的输出结构；增加 provider chunk wall-time、最大连续欠载、取消至 gate 可复用时间。
- 对比当前 pinned `616d3d3` 与新 pinned HEAD，只接受可复现的 TTFA/RTF/异常率改进；若无差异，保留当前 pin。

### B. dots.tts MF 2-step CUDA A/B

- 沿用 [`research-dots-tts.md`](./research-dots-tts.md) 的 P0：独立 `.venv-dots`，先普通 `generate_stream()`，不先做 STTS 文本 token 桥。
- 48 kHz 用有状态 2:1 重采样降到 24 kHz，保持 `KXAU` 与 Worklet 不变；单次只拉一个 `next()`，每个边界检查 CancelScope。
- 通过门槛：VoxCPM2 同机同参考音下，speaker similarity 最低值/离群率或听感明显更好；CER 不回归；TTFA p95 < 600 ms、RTF p95 < 0.8；100 次与取消恢复通过。

### C. 本地 CosyVoice3 0.5B

- 使用官方 `Fun-CosyVoice3-0.5B-2512` 与官方 streaming API，不能把当前 DashScope CosyVoice 云桥结果算成本地模型证据。
- 重点比较资源占用、首音、连续性、emotion/instruction 后的身份保持；若音色不如 VoxCPM2，但显著更轻更稳，可作为“低延迟本地”档而不是替换高保真档。

### D. IndexTTS-2.5 只做离线质量矩阵

- 比较无 emotion、8 维 emotion、语速控制三组；测身份漂移、异常长度和发音可控性。
- 上游没有真流式前不写 App adapter，不把整段 WAV 切片伪装成 provider streaming。

## 明确不做

- 不因模型卡的平均 SIM 更高就直接替换当前默认；必须看元元参考音的最低值、离群率和真人盲听。
- 不为候选修改 Volcano `realtime.rs::protocol`；这些都是本地级联 TTS，继续走现有 `managed-v1` / `provider-pcm-v1`。
- 不扩大队列、并行生成或 next prefetch 来掩盖 RTF > 1；这会恶化取消、显存和可听历史正确性。
- 不把社区 MLX/GGUF 转换当成官方跨平台支持；必须单独审计代码、权重来源、许可和量化质量。
- 不接入 Fish S2 产品路径，除非获得覆盖桌面应用使用/分发的书面许可；不恢复 Higgs，除非新的实现重新通过既有全部门槛。

## 主要一手来源

- [OpenBMB/VoxCPM README @ `f0c787f`](https://github.com/OpenBMB/VoxCPM/blob/f0c787f0937dc1c9a8f4f64d9a332d9c5da2e629/README.md)
- [VoxCPM2 Hugging Face model card](https://huggingface.co/openbmb/VoxCPM2)
- [dots.tts 官方仓库](https://github.com/studio-dots-ai/dots.tts)
- [Fun-CosyVoice3-0.5B-2512 model card](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- [IndexTTS-2.5 model card](https://huggingface.co/IndexTeam/IndexTTS-2.5)
- [IndexTTS-2.5 license](https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/LICENSE)
- [LongCat-AudioDiT-1B model card](https://huggingface.co/meituan-longcat/LongCat-AudioDiT-1B)
- [Fish Audio S2 Pro official repository](https://github.com/fishaudio/fish-speech)
- [Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md)
- [Microsoft VibeVoice Realtime model card](https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B)

## 验证状态

本调研完成了官方仓库、模型卡、包发布记录、许可证与本项目实现/历史测量的静态交叉核对。**没有下载新权重，也没有在 RTX 5080 或 Apple Silicon 上运行新模型**；因此候选排序是实验优先级，不是实机验收结论。
