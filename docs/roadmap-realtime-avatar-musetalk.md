# MuseTalk 实时通话虚拟形象接入计划

> 状态：方案设计，尚未进入产品实现  
> 日期：2026-08-20  
> 首期平台：Windows + NVIDIA RTX 5080  
> 上游：MuseTalk 1.5（代码 MIT；模型官方声明可商用；测试素材不可直接随产品分发）

## 1. 目标与非目标

### 1.1 产品目标

在现有实时通话中增加可选的 MuseTalk 虚拟形象：

- 使用预先准备的元元待机视频/帧环作为角色底片。
- 仅把**已被当前通话 generation 接受、将进入播放链路的 24 kHz PCM**送给 MuseTalk。
- 以 25 FPS 生成口型帧，在 `chat` WebView 的通话形象视图中显示。
- 声音仍是绝对主链路；形象变慢、崩溃或未安装时，通话不能中断。
- 用户插话、确认打断、回复 generation 改变、重连和挂断时，旧帧必须立即失效。
- 模型、角色帧、PCM、文本和 persona 全部留在本机。

### 1.2 首期非目标

- 不支持 macOS MuseTalk；M4 继续使用静态头像/轻量口型降级。
- 不把 MuseTalk 合并进 Qwen/CosyVoice Python 进程。
- 不让 MuseTalk读取 LLM 文本、Memory、ASR 或 persona。
- 不生成完整身体动作；MuseTalk 只负责已有待机帧上的脸部/嘴部重绘。
- 不默认捆绑数 GB 模型，不在 App 启动时自动下载。
- 不先做 WebRTC、H.264 或共享 GPU 纹理；首版使用有界 loopback WebSocket + JPEG 帧。

## 2. 必须先通过的可行性门

MuseTalk 面向真人脸，当前元元资产偏二次元。**在做产品集成前，先用真实目标资产完成一次隔离实验。**

### Gate A：角色资产

准备 3 组自有版权候选，每组 5--8 秒、25 FPS、512×512 或 512×640：

1. 当前二次元风格立绘/动画；
2. 半写实 2.5D 元元；
3. 写实数字人版本。

共同要求：

- 正脸或小幅转头，脸部至少约 256 px；
- 中性闭嘴，避免底片自身持续讲话；
- 头部、呼吸、发饰有轻微自然动作；
- 首尾可循环，或允许 MuseTalk 的 ping-pong 帧环；
- 背景固定，不先追求透明通道。

验收：

- 人脸检测、landmark、face parsing 连续成功；
- 中文快语速、短音节、静音、笑声下无持续脸崩/牙齿闪烁；
- 循环边界不发生明显跳帧；
- 至少一组资产达到可接受质量，否则停止 MuseTalk 产品接入，回到 2D/3D viseme 路线。

### Gate B：RTX 5080 运行时

建立独立 `.venv-musetalk`，不能复用 `.venv-qwen3`。验证：

- CUDA 12.8+ 对应 PyTorch；
- `torch.cuda.get_arch_list()` 包含 `sm_120`；
- 执行真实 Whisper encoder、PE、UNet、VAE decode smoke；
- 不是只检查 `torch.cuda.is_available()`；
- 记录热启动 FPS、首批耗时、峰值显存和连续 30 分钟显存变化。

Gate B 的最低目标：

- batch 4 或更小仍可持续生成 ≥25 FPS；
- 峰值显存为现有本地 TTS/ASR 留出安全余量；
- 若与 Windows faster-Qwen3 TTS 同卡并发不能稳定实时，则产品只允许以下策略之一：
  - 通话使用云端/CPU 不占 GPU 的语音后端；
  - MuseTalk 自动降级；
  - 后续验证串行 GPU admission，但不得拖慢可听音频。

## 3. 上游代码不能直接当流式服务使用

MuseTalk 官方 `scripts/realtime_inference.py` 的“realtime”含义是：

- 角色视频提前做人脸检测、mask 和 VAE latent 缓存；
- 推理时只运行 Whisper、PE、UNet 和 VAE decoder；
- 输入仍是一个完整音频文件；
- 所有 Whisper feature 先生成，再按 batch 输出帧；
- 示例最终写图片/MP4，不提供长期运行的流式会话协议。

因此需要保留模型算法，但重写外围运行方式：

1. 一次加载模型并常驻；
2. 一次加载已准备的 avatar cache；
3. 接受增量 PCM；
4. 使用滚动音频窗口生成 feature；
5. 小 batch 持续生成帧；
6. 根据 generation 取消旧工作；
7. 把帧按音频 sample clock 返回，而不是写文件。

不要直接在官方脚本外再套一层“每句写 WAV → 调脚本 → 读 MP4”。那会造成秒级首帧、无法及时打断，并引入磁盘和 FFmpeg 延迟。

## 4. 总体架构

```text
                         ┌────────────────────────────┐
 realtime backend       │ src/ai/realtime.js         │
 24k PCM ──────────────►│ generation/segment 校验    │
                         └────────────┬───────────────┘
                                      │ 同一份已接受 PCM
                         ┌────────────┴───────────────┐
                         │                            │
                         ▼                            ▼
               playback-worklet.js          RealtimeAvatarSession
               扬声器 + 精确播放时钟          音频/控制 WS
                         │                            │
                         │ played source samples      ▼
                         │                   Rust AvatarServiceManager
                         │                            │
                         │                            ▼
                         │                  MuseTalk Python sidecar
                         │                  Whisper→UNet→VAE→合成
                         │                            │
                         └────────────┬───────────────┘
                                      ▼
                              avatar canvas scheduler
                              按播放 sample clock 显示
```

### 核心原则

- **前端播放 Worklet 是媒体时钟权威。**
- Python 的生成速度和帧到达时间不能直接决定播放时间。
- 每个视频帧携带对应的 24 kHz `mediaSample`。
- UI 选择不晚于当前播放 sample clock 的最新帧；落后时丢视频帧，不延迟声音。
- 任何 generation/reset 都让旧帧失效，禁止跨回复复用。

## 5. 模块与 seam

### 5.1 Rust：独立 AvatarServiceManager

新增：

- `src-tauri/src/avatar_service.rs`

它是一个独立深模块，不并入 `voice_service.rs`。Interface 只负责：

- ensure/stop/check；
- 返回 loopback WS base；
- 安装器状态；
- App 退出时清理子进程。

Implementation 隐藏：

- Python 探测；
- 固定端口或随机 loopback 端口；
- secret；
- 子进程生命周期；
- 健康检查；
- 最近固定上限日志；
- setup/install admission；
- desired epoch，避免旧启动结果覆盖新设置；
- Windows `CREATE_NO_WINDOW`；
- 模型和 avatar cache 路径。

这样 MuseTalk 崩溃不会影响 Qwen/CosyVoice 进程，也不会扩大实时语音模块的 interface。

### 5.2 Python：长期运行的 MuseTalk adapter

新增目录：

```text
scripts/musetalk-runtime/
  server.py
  protocol.py
  runtime.py
  streaming_audio.py
  avatar_cache.py
  compositor.py
  model-lock.json
  runtime-lock.json
  NOTICE.md
  tests/
```

职责：

- `server.py`：loopback WS/health，单会话 admission；
- `runtime.py`：模型加载、warmup、小 batch 推理；
- `streaming_audio.py`：24k PCM → 16k、滚动 mel/Whisper feature、帧窗口；
- `avatar_cache.py`：只读加载准备好的帧、bbox、mask、latent；
- `compositor.py`：将 256×256 face result 合回待机帧并编码 JPEG；
- `protocol.py`：固定 header、枚举、大小上限和解析；
- tests：不加载模型的纯状态测试。

生产版本优先 vendor 经审计的 MuseTalk 最小推理代码并保留 MIT/第三方 notices；原型阶段可以使用固定 commit 的外部 clone。不要在产品运行时 `git clone main`。

### 5.3 前端：RealtimeAvatarSession

新增：

```text
src/ai/realtime-avatar.js
src/ai/realtime-avatar-protocol.js
src/ai/realtime-avatar-renderer.js
```

建议 interface：

```js
const avatar = new RealtimeAvatarSession(options);
await avatar.start(sessionInfo);
avatar.pushAudio(audioChunk);
avatar.updatePlaybackClock(clock);
avatar.reset(reason);
await avatar.stop();
```

内部隐藏：

- WS 重连；
- 有界音频队列；
- 帧解码；
- `createImageBitmap` 生命周期；
- generation/sequence 验证；
- 帧缓存；
- sample-clock 调度；
- JPEG 释放；
- 静态头像降级；
- 指标聚合。

`chat.js` 只负责选择设置、挂载 canvas、显示固定状态，不处理帧协议。

## 6. 私有协议

协议只绑定 `127.0.0.1`，使用 App 生成的 session secret；不加入浏览器通用 CORS allow-list，不写日志。

### 6.1 控制 JSON

前端 → Python：

```json
{"type":"start","protocol":"musetalk-stream-v1","avatarId":"kxyy-yuanyuan-v1","sourceRate":24000,"fps":25}
{"type":"reset","generation":7,"reason":"barge-in"}
{"type":"pause","generation":7}
{"type":"resume","generation":7}
{"type":"stop"}
```

Python → 前端：

```json
{"type":"session","state":"started","protocol":"musetalk-stream-v1","fps":25}
{"type":"ready","generation":7,"bufferedFrames":6}
{"type":"status","state":"warming"}
{"type":"error","reason":"runtime-unavailable","recoverable":true}
{"type":"stats","generated":100,"dropped":2,"queueDepth":3}
```

所有字符串必须是固定 allow-list；不得返回 raw exception、路径、模型文件名或用户内容。

### 6.2 上行音频 binary

固定大端 header，例如 `KXAA` v1：

- magic/version；
- generation；
- chunk sequence；
- generation 内 `mediaSampleStart`；
- sample count；
- PCM16LE mono payload。

约束：

- payload 最多 80 ms/1920 个 24k samples；
- sequence 必须从 0 严格递增；
- queue 有固定上限；
- generation 不匹配立即丢弃；
- 缺序、重序或溢出时 reset 当前视频 generation，不尝试补洞。

### 6.3 下行帧 binary

固定大端 header，例如 `KXAV` v1：

- magic/version；
- generation；
- frame sequence；
- 对应的 `mediaSample`；
- width/height；
- format=`jpeg`；
- payload length；
- JPEG payload。

约束：

- 首期固定 25 FPS；
- 最大画面尺寸和最大 payload 固定；
- frame sequence 严格递增；
- 帧队列建议最多 12 帧；
- generation 变化时同步清空待解码、已解码和正在显示的旧帧；
- JPEG 解码失败仅丢该帧。

## 7. 音频与视频同步

### 7.1 扩展 playback-worklet

修改 `src/ai/playback-worklet.js`：

- 每个 audio span 附带 avatar generation 和 `mediaSampleStart`；
- Worklet 在实际消费源 PCM 时维护当前 `mediaSample`；
- 以固定低频率（建议 25 Hz）发送 `playback_clock`：

```js
{
  type: "playback_clock",
  generation,
  mediaSample,
  state: "playing|paused"
}
```

- `duck` 到 paused 后时钟停止；
- `resume` 后继续；
- `clear` 立即清空时钟身份；
- ring overflow 时上报固定 `media_discontinuity`，前端 reset MuseTalk。

这比用 `performance.now()` 推算更可靠，因为现有 Worklet会重采样、暂停、恢复和清空。

### 7.2 启动 reservoir

MuseTalk 需要 Whisper 上下文和至少一个小 batch。首期固定策略：

- 目标视频预缓冲：6--10 帧（240--400 ms）；
- 当前音频 Worklet 的 240 ms startup reservoir 可扩展为 avatar-aware reservoir；
- 最多额外等待一个固定上限，例如总计 600 ms；
- 到上限视频仍未 ready：声音按时开始，UI 使用静态头像/简单音量嘴型；
- MuseTalk 后续追上后，只能从当前 sample clock 附近切入，不播放历史帧。

禁止为了保证视频完整而无限延迟 TTS。

### 7.3 打断

- speech candidate：现有 Worklet duck/pause；avatar scheduler 同时暂停；
- candidate rejected：音频和视频从同一 sample clock 恢复；
- confirmed interruption：`clear` + avatar generation reset，150 ms 内回到闭嘴/待机；
- transport recovery、response error、hangup：同样清空；
- 旧 generation 的迟到帧永不显示。

## 8. 增量 MuseTalk 推理

### 8.1 音频 feature

官方代码一次处理完整 WAV，并把 Whisper hidden states 全部展开。流式 adapter 应：

- 24k PCM 按固定整数比重采样到 16k；
- 保留有界 rolling audio window；
- 只为尚未生成的视频帧产生 Whisper feature；
- 保留官方左右 padding 语义；
- 不等待整句 SSE done；
- session reset 时清空 rolling state。

第一版允许保留约 200--400 ms lookahead，以换取口型质量；该延迟必须纳入音频 startup reservoir，而不是让视频永久落后。

### 8.2 batch

不沿用官方默认 batch 20。依次基准测试：

- batch 2：最低首帧；
- batch 4：首选平衡点；
- batch 6/8：仅在 5080 上可显著提高稳定吞吐时使用。

产品只暴露 `performance|balanced|quality` 固定 preset，不暴露任意 batch、padding 或 bbox 数字。底层参数由验证结果锁定。

### 8.3 帧环

- avatar preparation 生成原帧、ping-pong 序列、bbox、mask、mask crop 和 VAE latent；
- 通话 generation 开始时从确定的帧索引开始；
- 视频按音频 frame index 推进，不按 Python wall clock 推进；
- reset 后可回到中性帧，不能复用旧嘴型结果；
- avatar cache 带 schema/version/hash，任何底片或参数变化都要求重新 preparation。

## 9. UI 与设置

### 9.1 首期 UI

先在现有 `chat` window 内增加通话形象视图，不新增第四个窗口：

- 一个 `<canvas>` 显示 MuseTalk 帧；
- 顶部/底部保留状态、波形、挂断按钮；
- 用户可切回现有文字气泡；
- 胶囊模式不渲染视频，只显示波形；
- 从胶囊展开时使用当前帧，不重启会话。

原型可在现有 420×340 内替换消息区域；产品化后再把 Rust 聊天窗口状态从 boolean compact 深化为：

```text
normal | call-avatar | capsule
```

避免同时堆叠多个 resize flag。

### 9.2 Settings

新增固定设置：

- `realtimeAvatarProvider`: `off | musetalk`；
- `realtimeAvatarId`: allow-listed avatar id；
- `realtimeAvatarPreset`: `performance | balanced | quality`；
- `realtimeAvatarAutoFallback`: 默认 true。

设置页显示：

- 当前平台是否支持；
- runtime：未安装/安装中/可用/不兼容；
- model：未下载/校验中/可用；
- avatar cache：未准备/准备中/可用；
- 安装、检查、重新准备按钮；
- 预计磁盘占用和“仅 Windows NVIDIA”提示。

不保存任意脚本、模型、缓存或角色文件路径到普通 UI 设置。

## 10. 安装、模型和资源治理

新增：

```text
scripts/windows/setup-musetalk.ps1
scripts/windows/setup-musetalk.cmd
```

安装器职责：

1. 建立独立 venv；
2. 安装固定 cu128/Blackwell 兼容依赖；
3. 下载固定模型清单；
4. 校验文件名、大小和 SHA-256；
5. 执行真实 CUDA 模型 smoke；
6. 原子写 ready marker；
7. 失败时保留旧可用 runtime，不能留下半完成 marker。

App 安装包只带：

- setup 脚本；
- lock/manifest；
- adapter 代码；
- LICENSE/NOTICE；
- 自有角色底片或其下载 manifest。

大模型放 App-data runtime，不放 Tauri resources，不提交 git。重新安装 App 应保留 `.venv-musetalk`、模型和已准备 avatar cache，但必须重新验证版本/哈希/runtime。

## 11. GPU 资源策略

RTX 5080 可能同时承担 faster-Qwen3 TTS 和 MuseTalk。首期必须测三种组合：

1. Volcano/CosyVoice 云 TTS + MuseTalk；
2. Windows faster-Qwen3 + MuseTalk；
3. 本地 Ollama 文本 + faster-Qwen3 + MuseTalk。

运行策略：

- MuseTalk 只能有一个活跃 inference session；
- 队列有界，不允许后台积压；
- GPU OOM、CUDA kernel 错误或连续掉帧触发固定降级；
- 不自动重启并反复抢 GPU；
- avatar 降级不影响语音 backend；
- 若组合 2/3 无法保持 TTS 首音频和25 FPS，默认禁用该组合或降到轻量头像，不做无界调参。

## 12. 诊断与隐私

若纳入复制诊断 JSON，升级到新的 schema，只增加固定形状：

```json
{
  "avatar": {
    "provider": "musetalk|off|fallback",
    "status": "ready|warming|lagging|failed|unsupported",
    "targetFps": 25,
    "generatedFrames": 0,
    "displayedFrames": 0,
    "droppedFrames": 0,
    "staleFrames": 0,
    "resets": 0,
    "maxQueueDepth": 0,
    "firstFrameMs": 0,
    "syncErrorP50Ms": 0,
    "syncErrorP95Ms": 0
  }
}
```

禁止记录：

- PCM；
- JPEG/视频帧；
- 角色图或人脸 embedding；
- 用户/助手文本；
- persona/Memory；
- 本地路径、模型路径、URL；
- raw exception；
- wall-clock epoch。

## 13. 测试计划

### 13.1 无 GPU deterministic tests

Python：

- binary header roundtrip；
- generation、sequence、sample range 校验；
- PCM/frame queue 上限；
- reset 后旧任务不能发布帧；
- pause/resume 不推进媒体时钟；
- JPEG payload 上限；
- avatar cache manifest 校验；
- rolling feature state 的固定输入/输出 frame count。

JS：

- 帧 parser 拒绝 malformed/oversize/stale frame；
- scheduler 按 playback sample clock 选帧；
- 落后时丢旧帧；
- generation reset 释放所有 `ImageBitmap`；
-断连降级不结束通话；
- capsule/normal 切换不重启 MuseTalk generation。

Worklet：

- source-sample clock 精确推进；
- startup buffering 时不推进；
- duck/pause 时停止；
- reject/resume 连续；
- clear 清除 generation；
- overflow 产生 discontinuity；
- 重采样情况下 sample clock 仍以 24k 源样本计。

Rust：

- settings normalization；
- unsupported platform fail closed；
- desired epoch；
- health identity；
- stop/restart；
- App exit cleanup；
- installer progress sanitize。

### 13.2 RTX 5080 hardware gate

固定语料：

- 中文短句、长句、数字、英文夹杂；
- 快/慢语速；
- 静音、气音、笑声；
- 连续 20 分钟对话；
- 高频打断/恢复；
- TTS 很短 segment 和多个连续 segment。

记录：

- 冷/热启动；
- 首个可见帧；
- generated/displayed FPS；
- audio-video sync p50/p95；
- frame queue；
- 显存峰值/增长；
- TTS 首音频；
- CPU、GPU、系统内存；
- sidecar crash 后语音是否继续。

## 14. 产品验收门槛

首期 Windows 合入必须全部通过：

- RTX 5080 实际 `sm_120` kernel smoke；
- 热态持续 generated FPS ≥25，p95 不低于实时；
- 首个同步帧目标 ≤600 ms；
- 音画误差绝对值 p95 ≤120 ms；
- confirmed barge-in 后 ≤150 ms 不再显示旧 generation 嘴型；
- 连续 30 分钟无无界显存/内存增长；
- 视频帧落后时音频无新增卡顿；
- MuseTalk 进程崩溃后通话继续并在 ≤500 ms 内降级；
- 所有 PCM/帧/图片/路径不进入日志和诊断；
- 未安装、非 NVIDIA、macOS 均 fail closed；
- 角色资产和所有随包代码/模型许可清单完成。

## 15. 分阶段实施

### Phase 0：隔离可行性原型

交付：

- 独立 benchmark 脚本；
- 三种元元资产对比；
- 5080 batch 2/4/8 数据；
- 与 faster-Qwen3 并发数据；
- go/no-go 记录。

不改产品通话协议。

### Phase 1：离线 avatar preparation

交付：

- avatar cache schema；
- preparation CLI；
- manifest/hash；
- 首个自有 `kxyy-yuanyuan-v1` cache；
- 缓存加载和循环测试。

### Phase 2：流式 Python adapter

交付：

- `musetalk-stream-v1`；
- 增量 PCM、rolling feature、小 batch inference；
- generation cancellation；
- JPEG 帧输出；
- deterministic state tests。

先用合成 PCM 和虚拟 playback clock 测试。

### Phase 3：Rust 生命周期

交付：

- `AvatarServiceManager`；
- check/ensure/stop/get-base commands；
- health、secret、日志上限；
- installer/runtime/model 状态；
-退出清理。

### Phase 4：前端同步与降级

交付：

- `RealtimeAvatarSession`；
- playback Worklet source-sample clock；
- canvas scheduler；
- candidate pause/reject、confirmed reset；
- 静态头像 fallback；
- JS/Worklet tests。

### Phase 5：UI 与设置

交付：

- 通话形象视图；
- capsule 兼容；
-设置页安装/状态/选择；
- Windows only 提示；
-关闭时零额外开销。

### Phase 6：硬件验收和发布治理

交付：

- 5080 验收报告；
- 模型/依赖/角色资产 license 与 hash lock；
-诊断 schema 更新；
-安装/升级/卸载验证；
-文档和 AGENTS.md 同步。

## 16. 预计改动清单

新增：

```text
src-tauri/src/avatar_service.rs
src/ai/realtime-avatar.js
src/ai/realtime-avatar-protocol.js
src/ai/realtime-avatar-renderer.js
scripts/musetalk-runtime/**
scripts/windows/setup-musetalk.ps1
scripts/windows/setup-musetalk.cmd
```

修改：

```text
src-tauri/src/lib.rs
src-tauri/tauri.conf.json
src/ai/realtime.js
src/ai/playback-worklet.js
src/chat.html
src/chat.css
src/chat.js
src/settings.html
src/settings.js
package.json
AGENTS.md
```

## 17. 推荐的第一步

不要从 UI 或 Rust manager 开始。第一张任务卡应是：

> 在 RTX 5080 上使用 MuseTalk 1.5 和三种真实元元候选底片，建立 cu128/sm_120 独立环境；去掉写盘/MP4，只测常驻模型下 batch 2/4/8 的人脸质量、首批时间、持续 FPS、峰值显存，以及与当前 Windows faster-Qwen3 TTS 同时运行的资源竞争。输出 go/no-go 报告，不修改产品通话主链路。

只有 Phase 0 通过后，才值得投入流式协议和产品 UI。
