# macOS PyTorch「10 倍提速」与本项目的适用性（2026-10-25）

## 结论

**有局部研究价值，但没有依据认为本项目升级后能整体提速 10 倍。最值得做隔离版本 A/B 的是实验性 VoxCPM2；默认 macOS Qwen3-TTS / Whisper 使用 MLX，不直接受益。**

用户未提供新闻原文，不能唯一确认报道对象。找到最贴近该量级的官方发布是 **PyTorch 2.13（2026-07-08）MPS FlexAttention：特定长序列稀疏 attention 测试约 12.3 倍**。这不是所有模型、所有 MPS 算子或整条语音链路的倍数。[官方发布][p213]、[原始 PR 与测试][flex]

本机只读核查发现 VoxCPM2 独立环境已经安装 `torch 2.13.0`。当前上游固定版本的 MPS 路径采用 FP32、普通 SDPA，且优化入口限制为 CUDA，不能自动套用 FlexAttention 或半精度线性层测试结果。此次没有修改运行时、依赖、设置或产品代码，没有测得实际 TTS 加速。

## 官方究竟加速了什么

| 版本 / 改进 | 官方证据和测试边界 | 对本项目的意义 |
|---|---|---|
| 2.12，2026-05-13：Metal-4 shader 离线编译 | 减少运行时 shader 编译开销；不是通用推理 10 倍保证 | 更偏首次运行开销，不能代表持续生成速度。[发布][p212] |
| 2.13：MPS FlexAttention | `B=1,H=8,S=32768,D=64`，256 滑动窗口、0.8% 密度：35.05 ms vs SDPA 430.66 ms，12.29 倍；16384/window256 为 5.95 倍，32768/window1024 为 4.39 倍 | 需要模型真正使用对应稀疏注意力；默认升级不会把普通 SDPA 改写成它。[发布][p213]、[PR][flex] |
| 2.13：MPSGraph → 原生 Metal | copy/cast、随机数、比较、reduction、sort、scatter/gather 等算子降低部分编译和 dispatch 开销 | VoxCPM2 可能已从 2.13 获得部分收益，但没有本项目的实测倍数。[发布][p213] |
| 2.14，2026-09-02：`F.linear` decode 修复 | `[B,1,K]`、fp16/bf16 特定形状原先最高慢约 8.5 倍；PR 明确 **FP32 不受该问题影响**。表中 B=1 原先也没有该倍数差距 | 当前 VoxCPM2 默认 FP32，不能据此预测 8.5 倍收益。[发布][p214]、[PR #189855][linear] |
| 2.14：MPS prefill、GEMV、reduction、分配与拷贝改进 | MPP prefill 报告约 2–4 倍；该路径要求 macOS 26.2+、fp16/bf16、指定 head dimension 与 query length。发布文明确主要在 M5 验证，较早芯片不能直接套数 | FP32 与 M4 Pro 均需另测。其余算子改进仍可能有帮助，但必须看完整生成链路。[发布][p214] |

FlexAttention 的原始 PR 展示 `mps + bfloat16`、显式 `torch.compile(flex_attention, dynamic=False)` 和编译 block mask 的代码；可读 benchmark 正文未给出芯片型号与系统版本。官方把此功能列为 API Unstable，并明确 **dense attention 仍倾向于使用 SDPA**。因此不能把任意模型的 dense attention 改为滑动窗口后声称是无损加速，也不能把单算子收益当成端到端收益。[发布][p213]、[PR][flex]

## 本项目逐条对应

| 项目路径 | 当前 macOS 实现 / 代码证据 | 直接受益判断 |
|---|---|---|
| 默认本地 Qwen3-TTS | `server.py` 优先 `mlx-audio`，`requirements-macos.txt` 固定 `mlx-audio==0.4.4`、`mlx-lm==0.31.3` | 不直接受益。MLX 与 PyTorch MPS 是不同运行时 |
| 默认 Whisper ASR | `common.py::_load_whisper_fallback()` 优先 `mlx_whisper` | 正常 MLX 路径不直接受益；fallback 也不能假定运行于 MPS |
| 可选 SenseVoice / Silero shadow | `asr_adapter.py` 使用 sherpa-onnx CPU；`silero_shadow.py` 使用 ONNX Runtime CPU | 不直接受益 |
| CosyVoice / 火山云语音 | 云端生成，本地负责协议、PCM 与播放 | 升级本地 torch 不会改变云端模型推理 |
| 本地文字 / 视觉 | `src-tauri/src/local_text.rs` 管理 Ollama 服务 | 不直接受益；本项目 Python torch 版本不控制 Ollama 推理 |
| 实验性 VoxCPM2 | `voice_service.rs` 在 macOS 设置 `KXYY_VOXCPM_DEVICE=mps`；`server_voxcpm.py::_prepare()` 传入上游模型 | **唯一明确值得优先测新版 PyTorch 的现有路径** |
| Qwen PyTorch fallback | `tts_qwen3_torch.py` 只选择 CUDA 或 CPU，没有 MPS 分支 | 升级不会自动获得 Mac GPU 加速；迁移属于另一项工程工作 |

代码：[Qwen 服务](../scripts/local-realtime/server.py)、[macOS 依赖](../scripts/local-realtime/requirements-macos.txt)、[ASR 初始化](../scripts/local-realtime/common.py)、[SenseVoice](../scripts/local-realtime/asr_adapter.py)、[Silero](../scripts/local-realtime/silero_shadow.py)、[VoxCPM adapter](../scripts/local-realtime/server_voxcpm.py)、[Rust 管理器](../src-tauri/src/voice_service.rs)、[Ollama](../src-tauri/src/local_text.rs)、[Qwen torch](../scripts/local-realtime/tts_qwen3_torch.py)。

### VoxCPM2 的关键限制

项目 macOS setup 固定上游 `616d3d3e630a9c96c2853250eef91b0f39dcd5fa`。本机已安装的对应源代码显示：

- `model/utils.py::pick_runtime_dtype()`：MPS 默认把 fp16/bf16 转为 FP32；注释说明扩散自回归循环中的半精度数值漂移曾引起音频异常和反复重试。不能为了使用半精度 benchmark，直接移除该保护。
- `model/voxcpm2.py::optimize()`：设备不是 CUDA 就跳过 compile 优化。升级 PyTorch 不会自动改变这条上游分支；不能简单添加 `torch.compile(model)` 并认定已完成接入。
- `modules/minicpm4/model.py`：prefill / decode 调用 `scaled_dot_product_attention(..., enable_gqa=True)`，没有 `flex_attention` 接入。当前语义和新闻里的 32768-token 稀疏滑动窗口测试不同。
- 本项目已有 prompt cache、逐块生成、单 lane 与无下一句预取约束。PyTorch 版本升级不替代这些机制，也不证明首音延迟、片段连续性和取消恢复达标。

上游定位：[dtype 与设备选择][voxutils]、[模型优化入口][voxmodel]、[attention][voxattn]。此次 dtype/compile/attention 结论由本机已安装源码直接核查；上游 raw 下载超时，未额外宣称已完成远端逐字一致性校验。项目安装入口：[setup-voxcpm2.sh](../scripts/macos/setup-voxcpm2.sh)。

## 本机状态与建议

只读检查环境元数据与硬件信息，未运行模型、未读取账户凭据：

- Apple M4 Pro、48 GB、macOS 26.6.2。
- App-data `.venv-voxcpm2`：`torch 2.13.0`、`voxcpm 2.0.3.post22+g616d3d3e6`；另见 `torchaudio 2.11.0`，若做实验需核对官方配套版本，不能原地混升。
- App-data `.venv`：`mlx 0.31.2`、`mlx-audio 0.4.4`、`mlx-whisper 0.4.3`、`torch 2.12.1`。存在 torch 包不代表 MLX 推理会经过 torch。

**建议优先级：保留默认 MLX；如要验证这轮更新，先对 VoxCPM2 做隔离的 2.13 → 2.14 FP32 A/B。** 当前证据足以决定测试对象，尚不足以决定切换运行时或默认后端。

下一步实验应保持相同模型文件/hash、上游 commit、参考音、文本、seed、推理步数、prompt cache 与单 lane；分别统计冷启动与预热后的首个 PCM、provider chunk 间隔、RTF（生成耗时 / 音频时长）、内存、取消后恢复与失败率。不要同时改精度或注意力语义，否则无法归因到 torch 升级。若 FP32 已有收益，再单独评估半精度的音质、稳定性与重试风险。

只有 provider 的同机结果通过后，才接真实 App 检查 `audibleGapMs`、断续、候选暂停/拒绝、打断、挂断和重新通话。RTF < 1 是持续播放的必要性能条件之一，仍不能替代片段连续性与交互验收。产品改动需遵守[开发测试循环](./testing-development-loop.md)。

## 验证状态

已完成官方发布与 PR 查证、项目调用路径检查、本机安装版本和上游已安装源码检查，以及本文链接/内容检查。未做 torch 版本安装或升级、合成性能 A/B、盲听、真实 App E2E；因此没有本项目的加速倍数结论。此次只增加研究文档，不改变功能，不运行行为测试 gate。

[p212]: https://pytorch.org/blog/pytorch-2-12-release-blog/
[p213]: https://pytorch.org/blog/pytorch-2-13-release-blog/
[p214]: https://pytorch.org/blog/pytorch-2-14-release-blog/
[flex]: https://github.com/pytorch/pytorch/pull/182552
[linear]: https://github.com/pytorch/pytorch/pull/189855
[voxutils]: https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/src/voxcpm/model/utils.py
[voxmodel]: https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/src/voxcpm/model/voxcpm2.py
[voxattn]: https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/src/voxcpm/modules/minicpm4/model.py
