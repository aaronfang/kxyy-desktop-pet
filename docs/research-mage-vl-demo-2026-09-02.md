# Mage-VL Demo 与实时通话结合评估（2026-09-02）

## 结论

可以作为“共同观看”功能的视觉模型候选，但不能把 `GaoJuqian/mage-vl-demo` 直接当作实时视觉服务接入。该 demo 的摄像头模式只是 Gradio 定时器每 1--10 秒抓取一张图片，然后串行调用一次图像生成；没有视频流协议、增量视觉状态、事件回调或 WebSocket API。它适合验证模型效果，不适合直接承载桌宠通话的低延迟数据面。

微软官方 Mage-VL 仓库确实提供事件门控的 streaming 参考脚本，但脚本处理的是本地视频文件：按默认 8 秒切片、先把所有片段预处理完，再调用 `streammind_gate_forward_segments`，达到阈值的片段才生成文字。它仍是离线/批量命令行示例，不是摄像头或屏幕捕获服务。

## 一手证据

### GaoJuqian demo

- README 明确写明设备为 Apple M4/macOS 26.1，使用 MLX 8bit 约 5 GB 模型；“摄像头实时连续分析”默认每 3 秒抓帧，间隔可调 1--10 秒（[README.md](https://github.com/GaoJuqian/mage-vl-demo/blob/74df828c81351f92d11cbc3ea0094b795f646bb4/README.md#L13-L19)）。README 同时标注“内容由AI生成，仅供参考”（同文件 L69-L77）。
- 代码中的 `realtime_cam` 只是调用 `chat_with_image`；`gr.Timer.tick(..., trigger_mode="always_last")` 每次传入一张 PIL 图片并等待 `mlx_vlm.generate` 完成（[mage_vl_demo.py](https://github.com/GaoJuqian/mage-vl-demo/blob/74df828c81351f92d11cbc3ea0094b795f646bb4/mage_vl_demo.py#L139-L176)）。因此没有跨帧记忆或“连续对话”语义，上一帧结果也不会自动进入下一次 prompt。
- 视频 Tab 是 OpenCV 均匀抽取 8--64 帧，保存临时 JPEG 后一次性调用 `generate`（同文件 L34-L75）；这不是实时视频解码。
- demo 仓库当前树只有 `.gitignore`、`README.md`、`mage_vl_demo.py`，没有 LICENSE 文件（提交 `74df828c81351f92d11cbc3ea0094b795f646bb4`）。因此不能仅依据 demo 仓库声明其代码许可；需分别遵守依赖和模型的许可。

### 微软官方 Mage-VL

- 官方仓库 `microsoft/Mage` 的 `mage_vl/inference_streaming.py` 文档字符串称其为 event-gated inference；参数默认 `segment_sec=8.0`、`cur_fps=2`、设备 `cuda`，输入参数是必需的本地 `--video` 路径（[源码](https://github.com/microsoft/Mage/blob/main/mage_vl/inference_streaming.py#L1-L43)）。
- 实现先用 ffmpeg 对整个视频按非重叠片段切片并构造所有 segment inputs，然后一次性运行 `model.streammind_gate_forward_segments(visual_segments)`；只有概率达到 `gate_threshold` 的片段才调用标准 `model.generate` 输出文字（[源码](https://github.com/microsoft/Mage/blob/main/mage_vl/inference_streaming.py#L151-L224)）。这证明模型有事件门控能力，但不提供可复用的实时摄像头/屏幕采集协议。
- 官方代码仓库 LICENSE 是 MIT（[LICENSE](https://github.com/microsoft/Mage/blob/main/LICENSE)）。Hugging Face `microsoft/Mage-VL` 模型卡标注模型许可为 Apache-2.0（[模型卡](https://huggingface.co/microsoft/Mage-VL#license)）。代码、模型权重、`mlx-community/Mage-VL-8bit` 量化权重应分别核对许可和再分发条件，不应把 demo 的缺失许可证当作授权。
- 官方模型卡描述 Mage-VL 为 4B、codec-native/proactive streaming 模型，声称视觉 token 减少超过 75%、最高约 3.5x 推理加速；这些是论文/作者报告的 benchmark 数字，不是本机端到端延迟保证（[模型卡](https://huggingface.co/microsoft/Mage-VL#readme)）。

## 与当前实时通话的接入边界

当前项目的实时通话链路是浏览器音频 + Rust WebSocket bridge：`start` 消息承载 `systemRole`/`botName`，下行是 24 kHz PCM 或项目私有 `managed-v1` 音频包；Volcano 供应商协议不能被 Mage-VL 改写。视觉输入应是旁路能力，不应伪装成音频帧或修改 `realtime.rs::protocol`。

可行的原型拓扑：

1. 在本地 Python sidecar 中捕获用户明确选择的窗口/屏幕或摄像头（macOS Screen Recording/Camera 权限，Windows capture 权限），以固定低频率采样；不要默认上传整屏。
2. sidecar 调用 Mage-VL（M4/MLX 路径）或官方 PyTorch/CUDA 路径，维护短期视觉摘要和最近一次带时间戳的观察。首版可以采用 3--8 秒窗口/单图，跳过无变化帧；不要把每帧结果写入 Memory、诊断或聊天历史。
3. 仅当用户说“我们看到的……”或显式开启共同观看时，把经过长度限制、来源标记和新鲜度检查的观察作为一次性 `visual_context` 注入下一次文本/语音 LLM 请求；观察过期即丢弃。角色主动评论应另设冷却、打断和失败回退规则，沿用现有 realtime proactive 的本地/CosyVoice 限制。
4. 通过现有 Rust loopback 管理 sidecar 生命周期、端口和鉴权；前端只接收固定形状的状态/文本事件。不要把 Gradio `share=True` 公网隧道用于产品路径。

主要风险：单图轮询的 1--10 秒粒度与模型生成时间会造成明显观察延迟；连续视频需要解码、缓存、GPU/统一内存和背压；屏幕内容可能含隐私/密钥；视觉摘要若进入长期记忆会违反当前 Memory 与 persona 治理；模型/量化权重许可和第三方依赖需要单独审计。建议先做“用户按键触发一次观察 + 下一轮问答引用”的垂直原型，再测端到端首 token、内存和取消/通话打断，暂不承诺实时连续陪看。

## 参考版本

- `GaoJuqian/mage-vl-demo` HEAD：`74df828c81351f92d11cbc3ea0094b795f646bb4`（2026-08-02）。
- `microsoft/Mage` 与 `microsoft/Mage-VL` 链接均为 2026-09-02 访问；上游脚本和模型卡可能继续变化，集成前应锁定具体 commit/权重 revision。
