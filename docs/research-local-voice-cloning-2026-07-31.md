# 本地声音克隆替代方案调研（2026-07-31）

## 结论

有比当前 Qwen3-TTS 1.7B 零样本链路更值得实测的选择，但不能只凭公开榜单直接替换。

首选实验对象是 **VoxCPM2**：官方公开的同一套 Seed-TTS-eval 表中，中文零样本声纹相似度（SIM）为 **79.5**、CER 为 **0.97**；同表 Qwen3-TTS 1.7B 为 **77.0 / 1.22**。它支持参考音 + 文本的高保真克隆、原生音频流式、固定 seed、约 8 GB 显存，并且代码和权重均标为 Apache-2.0。对“偶发整句换人”这个问题，公开指标和可固定随机性都比继续盲调 Qwen 更有针对性。[VoxCPM2 官方仓库与基准](https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/README.md#performance)；[官方模型卡](https://huggingface.co/openbmb/VoxCPM2)

第二选择是 **本地 Fun-CosyVoice3 0.5B**。它更轻、明确支持文本输入和音频输出双流式，官方声称首包最低 150 ms，中文 SIM 78.0。不过当前项目里的 `CosyVoice` 是 DashScope 云服务桥接，不是这个本地开源模型；本地 CosyVoice3 会是一个新后端。其官方依赖仍固定到 PyTorch 2.3.1/cu121，对 RTX 5080 不可直接照装，必须先做 cu128 运行时适配和真实 CUDA smoke。[CosyVoice3 官方说明与基准](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/README.md#highlight)；[官方依赖](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/requirements.txt)

如果目标从“零样本更稳”转为“用少量角色素材训练专用音色”，**GPT-SoVITS** 比昨天尝试的 Qwen LoRA 更贴合这个任务：官方路径明确区分 5 秒零样本和约 1 分钟 few-shot 微调，并提供 Windows/cu128 安装。代价是训练和模型管理复杂度更高；官方流式实现自己标注为中等质量、响应仍慢，不宜未经听测直接承担实时通话主链路。[GPT-SoVITS 官方 README](https://github.com/RVC-Boss/GPT-SoVITS/blob/d523079fc05d9a8028d6085bffe4a2757c32abb6/README.md#features)；[流式实现说明](https://github.com/RVC-Boss/GPT-SoVITS/blob/d523079fc05d9a8028d6085bffe4a2757c32abb6/GPT_SoVITS/TTS_infer_pack/TTS.py#L1024)

## 候选对比

| 方案 | 中文克隆证据 | 本地流式/实时 | Windows RTX 5080 | 许可 | 对本项目的判断 |
| --- | --- | --- | --- | --- | --- |
| **VoxCPM2 2B** | 官方 Seed-TTS-eval：ZH SIM 79.5、CER 0.97；支持参考音+转写的 Ultimate Cloning | `generate_streaming()`；RTX 4090 标准 RTF ~0.30，约 8 GB；Nano-vLLM RTF ~0.13 | 依赖 PyTorch >=2.5/CUDA >=12，未固定旧 CUDA；仍需在 cu128 上验证 `sm_120` 和真实生成 | Apache-2.0，模型卡明确 commercial-ready | **P0，最值得直接进入固定语料 A/B** |
| **Fun-CosyVoice3 0.5B** | 官方表：ZH SIM 78.0、CER 1.21；9 种语言和 18+ 中文方言/口音 | 双流式，官方最低 150 ms | 官方 requirements 固定 torch 2.3.1/cu121；RTX 5080 需改依赖并实测，不能视为现成支持 | 代码与模型卡 Apache-2.0 | **P1，架构很适合，但 Windows 运行时适配成本高** |
| **GPT-SoVITS** | 5 秒零样本；约 1 分钟数据 few-shot；中文/粤语及跨语种 | 有分块和 streaming mode，但官方代码注明质量/响应折衷 | 官方列出 Windows 10+、PyTorch 2.7/cu128 安装路径 | 仓库与官方预训练模型卡 MIT | **P1，适合专用音色微调，不是首个零样本替换实验** |
| **IndexTTS2 1.5B** | 官方论文/仓库强调情绪与音色解耦；公开对比 ZH SIM 76.5、CER 1.03 | 官方 Python 用法返回完整波形，未提供面向语音代理的流式接口 | 官方已固定 torch 2.8/cu128，并写明 Windows 安装注意事项 | Bilibili 自定义模型许可；超 1 亿 MAU 或年收入超 10 亿元需另行授权，并有下游义务 | **P2，可做文字朗读 A/B，不适合先改实时链路** |
| **Chatterbox Multilingual V3 中文专模 0.5B** | 官方中文单语言微调模型，目标是加强中文质量控制与声音克隆；暂无可与上述同表核对的中文 SIM | 本地示例返回完整 waveform；低延迟 Turbo/Nano 仅英语 | 官方包固定 torch 2.6.0，未给 RTX 5080/cu128 验证路径 | 仓库与中文模型卡 MIT；输出强制嵌入 PerTh 水印 | **P2，许可友好，但实时和 5080 证据不足** |
| **Fish Audio S2 Pro 4B** | 官方报告中文 WER 0.54%，80+ 语言，强调 timbre similarity | SGLang 流式；官方推理要求至少 24 GB 显存 | 官方提供 cu128 依赖，但 24 GB 门槛可能超过目标设备 | Fish Audio Research License；任何商业产品/内部业务都需单独书面许可 | **排除产品集成；仅可研究评估** |
| **FireRedTTS2 1.5B** | 中文、多语、零样本；官方称长对话稳定 | 80 ms chunk，L20 首包最低 140 ms；bf16 约 9 GB | 官方安装是 cu126，未验证 5080 | 仓库是 Apache-2.0，但 README 同时写明声音克隆“solely for academic research” | **许可表述冲突，获得书面澄清前排除** |

## 关键依据与边界

### VoxCPM2

- 官方仓库公开 `generate_streaming()`，并明确区分普通参考音克隆与“参考音 + 精确转写”的 Ultimate Cloning；后者更符合项目已有 `ref.wav + ref.txt` 资产。[官方 Python API](https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/README.md#python-api)
- 官方表给出 VoxCPM2 约 8 GB 显存、RTX 4090 RTF ~0.30，以及中文 SIM 79.5；这些是供应方公布的数据，不等于本项目参考音上的稳定性结论。[官方模型对比与性能](https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/README.md#models--versions)
- API 暴露 `seed`。固定 seed 可能降低同文本重复生成的随机波动，但不能假定它会消除跨文本的音色漂移；仍要测句间 speaker embedding 离群率。
- PyPI 配置只要求 `torch>=2.5.0`，没有把运行时锁死在 cu121/cu124，因此可以在项目已经验证的 cu128 PyTorch 环境中试装。[官方 pyproject](https://github.com/OpenBMB/VoxCPM/blob/616d3d3e630a9c96c2853250eef91b0f39dcd5fa/pyproject.toml)

### 本地 Fun-CosyVoice3

- 官方开源模型卡标注 Apache-2.0，支持中文、跨语种克隆、文本/音频双流式和 instruction。[官方模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
- 对当前产品，最大风险不是模型能力而是 Windows 运行时：仓库把 torch/torchaudio 固定为 2.3.1 并默认 cu121；这早于 RTX 5080 所需的 Blackwell/cu128 支持。可以实验性替换依赖，但结果不再是官方验证组合。
- 本项目现有 `scripts/local-realtime/tts_cosyvoice.py` 调的是 DashScope 云端 CosyVoice；不能把它当成本地 CosyVoice3 已经接入。

### GPT-SoVITS

- 官方 README 明确提供零样本和 few-shot 两条产品路径，并公布 Windows/cu128 安装命令及 RTX 4060 Ti/4090 的 RTF 数据。[官方 README](https://github.com/RVC-Boss/GPT-SoVITS/blob/d523079fc05d9a8028d6085bffe4a2757c32abb6/README.md)
- 其优势是“少量角色素材适配”已经是核心工作流，而非给通用 TTS 强行加 LoRA；但训练数据的切分、转写、噪声和情绪覆盖会直接影响结果。
- 当前官方 TTS 类把 streaming mode 注释为 `Medium quality, Slow response speed`，固定长度 chunk 可更快但降低质量。因此应先验证文字朗读和缓存音频，再决定是否用于实时通话。

### IndexTTS2 与 Chatterbox

- IndexTTS2 的官方环境已经选择 torch 2.8/cu128，Windows 适配证据较强；但官方仓库没有提供与 CosyVoice/VoxCPM 类似的实时输出 API，且自定义许可需要产品侧审阅。[官方安装与依赖](https://github.com/index-tts/index-tts/blob/13495845e3028f0bb6ca1462ad22aa0e76349e40/pyproject.toml)；[模型许可](https://github.com/index-tts/index-tts/blob/13495845e3028f0bb6ca1462ad22aa0e76349e40/LICENSE)
- Chatterbox 新增了普通话单语言微调权重，许可简单，但中文专模发布说明没有公开中文声纹基准；官方低延迟型号又只支持英语。[中文模型卡](https://huggingface.co/ResembleAI/Chatterbox-Multilingual-zh-cmn)；[官方模型矩阵](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/README.md#model-zoo)

### 排除项

- Fish Speech/S2 Pro 的代码和权重均受 Fish Audio Research License 约束，商业产品、收费服务乃至组织内部业务均需单独书面许可，不满足默认可分发条件。[官方许可](https://github.com/fishaudio/fish-speech/blob/e5e292632cb11e7a27b2b7487f58f612bc101e13/LICENSE)
- FireRedTTS2 仓库根许可证虽为 Apache-2.0，README 却把 zero-shot voice cloning 限定为仅供学术研究。两个官方文本冲突时，不应按较宽松者自行解释。[官方 README 免责声明](https://github.com/FireRedTeam/FireRedTTS2/blob/404f3f61d25bb4804859b588a6a734bf8468090c/README.md#usage-disclaimer-%EF%B8%8F)

## 建议实验顺序

1. **先做 VoxCPM2 离线 A/B，不接 App。** 复用现有 4 条固定文本 × 5 次的基线，并扩为 10--20 条高风险中文：短感叹句、情绪句、数字、英文混合、连续标点。分别测试随机 seed 和固定 seed。
2. **记录四类指标。** speaker embedding 均值/最低值/离群率、CER、首包延迟/RTF、峰值显存；另由人耳盲听“像不像元元”和“是否整句换人”。公开 SIM 只用于筛选，不能替代角色参考音实测。
3. **先验证完整句，再验证流式。** 同一文本在 `generate()` 与 `generate_streaming()` 下分别测，确认流式没有引入声纹或句首质量回归。
4. **设置硬门槛再决定接入。** 至少要求声纹最低值和离群率优于当前 Qwen 基线、CER 不退化、RTX 5080 的 PyTorch 架构包含 `sm_120`、真实 CUDA tensor smoke 通过、连续 100 次生成无崩溃/显存增长。
5. **VoxCPM2 未胜出时再测 GPT-SoVITS few-shot。** 这条路线回答的是“专用角色音色是否更稳定”，不与零样本调参混在同一实验里。

## 推荐决策

当前不应直接宣布替换 Qwen3-TTS。建议建立一个独立实验分支，第一轮只安装和测试 **VoxCPM2**；若固定语料的声纹最低值、离群率和人耳盲听都显著优于 Qwen，再设计本地服务 adapter。它同时具备更高的公开中文 SIM、原生流式、可固定 seed、可接受显存和宽松许可，是目前证据最完整的候选。
