# OpenLess 语音输入链路调查

基于 OpenLess 提交 `fc9824eeccf7218e3b44c1de6c6e284a4c494c81` 的源码调查，重点关注从全局热键到文字落点的完整路径，以及对元元桌宠语音输入质量/效率的可借鉴点。

## 1. 完整链路

典型路径是：`HotkeyMonitor` 产生 Pressed/Released -> coordinator 状态机创建 `session_id` -> `Recorder(cpal)` 在独立线程采集 -> 统一成 16 kHz、单声道、Int16-LE PCM -> `AudioConsumer` 推给实时或批量 ASR -> 得到 `RawTranscript{text,duration_ms}` -> 可选 LLM polish/translate -> `TextInserter` 通过 fcitx、剪贴板或 Unicode SendInput 写入当前应用。

`AudioConsumer` 只有一个窄接口（`asr/mod.rs:32-37`），录音器和 provider 解耦；ASR 可在内部决定分帧、网络批量或本地推理方式。

## 2. 录音与 PCM 质量

### 固定格式和重采样

`recorder.rs:1-11,25-36` 明确规定输出为 16 kHz/mono/16-bit little-endian。多声道做算术平均下混，非 16 kHz 用带跨回调 phase 的线性插值重采样（`recorder.rs:662-706`），避免每个 callback 重新起相位造成边界 click/时长漂移。量化前计算 RMS，既供静音判断也供 UI 电平动画（`recorder.rs:586-610`）。

对桌宠的启示：无论系统输入设备是 44.1/48 kHz、双麦还是浮点格式，都应在一个集中入口归一化；不要让每个 ASR adapter 各自重采样。当前 realtime.js 已发送 16 kHz PCM，可进一步把浏览器 AudioWorklet 的重采样、下混、饱和/削波统计固定成与 Rust 相同的契约，并对跨 buffer phase 写测试。

### 设备、权限和启动失败

录音器同步等待音频线程回报 startup 结果（`recorder.rs:88-130`），运行期错误另走 channel；错误分为 `NoInputDevice`、`PermissionDenied`、`EngineFailed` 并映射成用户可执行的中文提示（`recorder.rs:46-68`）。优先按用户选择的设备名，找不到时回退默认设备（`recorder.rs:387-430`）。

可借鉴：在 `prepare()` 阶段就验证设备/权限，并在 UI 展示“无设备/权限拒绝/引擎故障”三个稳定枚举；设备拔出后不要把原始平台错误直接暴露给用户。设备选择应保存稳定名称但始终允许回退默认设备。

### 录音 liveness watchdog

cpal stream 在专用线程持有，因为 `Stream` 是 `!Send`。watchdog 每秒检查 callback 心跳，首次 callback 5 秒内必须出现，运行中静默超过 3 秒报告故障；睡眠切成 50 ms 片段并在检查前重新读取 stop flag，保证主动停止不会被误报（`recorder.rs:240-335`）。停止顺序是设置 flag -> `stream.pause()` -> drop -> join，避免 macOS CoreAudio callback 和麦克风指示灯残留。

当前桌宠应增加“采集心跳/首次帧 deadline/主动停止抑制错误”的诊断字段。对 AudioWorklet，等价策略是主线程定时检查最近收到的 worklet帧；hangup/cancel 后先标记 generation 无效，再忽略迟到帧。

### 可选 WAV 旁路归档

录音开始时尝试创建 WAV archiver，失败只警告但通过返回值告知调用方是否真的生成了文件（`recorder.rs:80-110`），防止设置开关打开却在历史中显示一个不存在的播放按钮。这个设计适合桌宠的“调试录音”开关：记录是否实际落盘、限制时长/容量，并且绝不把失败路径当成可播放资产。

## 3. 热键与会话竞态

### 物理按键判定

`dictation.rs:20-44` 对热键做 250 ms debounce；Auto 模式以 350 ms 按住时长区分短按锁存和长按松手即停。仅修饰键触发时先等待 150 ms 组合键仲裁窗口，若期间出现普通键则整次作废，避免 Option/Alt 组合键误开麦。

这比单纯监听 keydown/keyup 更贴近用户意图。桌宠可在 call 按钮/快捷键上增加：短按开始/再次短按结束，长按松手结束，组合键 grace，且时间戳应来自事件产生时刻而非 IPC 排队时刻。

### 纯状态机和 session token

`coordinator_state.rs:21-53` 将阶段建模为 `Idle/Starting/Listening/Processing/Inserting`，并记录 `pending_stop`、`cancelled`、`focus_target`、UUID `session_id`。`begin_session_state` 只有 Idle 可进入 Starting 且生成新 UUID（`coordinator_state.rs:71-90`）；握手期间收到 stop 会记录 pending，握手结束立即收尾（`coordinator_state.rs:92-131`）。所有异步 continuation 先比较 session id；旧会话的 recorder 错误不能终止新会话。

取消分两段：`begin_cancel_session_state` 在 Idle/Inserting 禁止取消，在其它阶段只置 cancelled（`coordinator_state.rs:154-171`）；Processing 不直接改 Idle，交给 end_session 在安全检查点收尾（`coordinator_state.rs:173-180`）。Inserting 阶段禁止取消是因为 Cmd+V 已不可撤销，避免 UI 报 cancelled 但文字实际落下。

这是当前桌宠最值得直接复用的模式：把 `generation` 扩展成统一 session token，所有 mic、ASR、LLM、播放 receipt、UI 事件都带 token；在每个 await、发送边界和插入前检查。对 `Starting` 增加 pendingStop，可消除用户快速点击时“麦克风已开但停不下来”的竞态。

### Esc 独立取消通道

`hotkey_loops.rs:10-55` 将 Esc 取消放到独立消费线程，因为热键 bridge 可能被 Hold 松开后的完整转写阻塞；Esc 必须走同步快路径（置旗、清资源），不能排在同一队列。组合键撤销通道还携带 press id，避免迟到撤销误取消下一次会话。

桌宠的 candidate/barge-in 取消也应走独立、无 await 的控制通道；不要把 cancel 事件塞入 LLM/ASR 数据队列。为每次物理按下分配 press id，可防止快速重拨时旧 release 误伤新 call。

## 4. 静音自动停止与效率

`silence_auto_stop.rs:1-82` 是不依赖外部时钟的纯检测器：RMS 电平达到 0.02，连续 3 个约 5 ms block 才确认说话；说话后静音达到配置阈值返回一次性 `Stop`；录音开始 10 秒仍无语音返回 `Cancel`，后续帧不再重复决策。测试覆盖短噪声、阈值边界、说话后重新计时和 one-shot 行为（`silence_auto_stop.rs:107-190`）。

建议桌宠在 toggle 模式引入同样的“未开口自动取消 + 说完静音自动结束”，但阈值应按设备校准并保留 30 ms 帧对齐。RMS 只用于候选/endpoint，不要让 shadow 神经 VAD 改变线上决定。可增加自适应噪声底（启动前 200~500 ms 估计）但最终输出仍映射到固定、可测试的枚举。

## 5. ASR provider 与超时

OpenLess 用统一 `RawTranscript`，实时 provider 实现 `AudioConsumer` 并暴露 `send_last_frame/await_final_result/cancel`；批量 Whisper/MiMo 先缓存 PCM 再 transcribe。协调层按 provider 选择超时，超时后显式 cancel 并驱逐可能仍占用资源的本地引擎（`coordinator/qa_session.rs:490-754`）。

可借鉴：把 realtime 的“发送结束帧”和“等待最终结果”拆成两个可观测阶段；为本地模型记录 warmup/推理耗时，超时后不要立即复用同一 engine。ASR 结果至少保留文本和音频时长，便于质量、吞吐和端到端延迟分析。

## 6. 流式润色与插入

`polish.rs:59-93` 将流式 LLM 超时拆成首 token、idle 两把尺子：首 token 按输入长度动态预算，输出过程中只要持续有 chunk 就不因固定 30 秒总时限被截断。`polish_flow.rs` 的 `StreamingPolishOutcome` 区分 `Streamed`、`UnsupportedFallback`、`Failed`；每个 SSE chunk 同步调用 `on_delta`，失败时调用方回退 raw 文本，不重复插入。

对桌宠：如果未来做“语音转写后边生成边显示/插入”，必须维护已插入字符数和 generation，成功流式路径不能再执行一次性 paste；流式失败只能插入尚未输出的 raw 或显示可复制回退。当前 voice call 以整句播放为主，可借鉴其分阶段 timeout（连接、首结果、idle、总预算）提升等待体验。

## 7. 插入可靠性与平台回退

`insertion.rs:1-110` 统一先写剪贴板再模拟粘贴；Linux 优先 fcitx CommitText，失败回退剪贴板；Windows 支持可配置 paste shortcut 和 Unicode SendInput，并校验实际输入字符数；macOS 粘贴失败时保留转写在剪贴板供手动粘贴，成功且开启设置才异步恢复用户原剪贴板。

桌宠若增加“语音输入到前台应用”，建议保留三层回退：原生输入法/Accessibility -> 剪贴板粘贴 -> 仅复制并明确提示。插入前后都要验证目标窗口仍是本次 session 捕获的 focus，避免用户切换窗口后误写；剪贴板恢复应延迟且只在粘贴成功时执行。

## 8. 测试与可落地优先级

OpenLess 的关键质量保障是纯函数/纯状态测试：PCM 时长和重采样边界、静音检测、session race、ASR 帧解析、插入布局与 provider timeout 都可在无麦克风/无账号 CI 中运行。当前工程可按以下顺序吸收：

1. 为 realtime.js 建立 `Starting/Listening/Stopping/Processing/Playing` 纯状态转移表，覆盖快速 start/stop、迟到帧、重复 hangup、旧 generation。
2. 为 AudioWorklet 增加固定输入采样率/声道/跨 buffer phase 的 golden tests，并暴露首次帧 deadline 与 callback heartbeat。
3. 增加 RMS 静音自动停止（未开口取消、连续语音确认、一次性 Stop）测试，阈值和帧数全部常量化。
4. 为 ASR/LLM 分阶段 timeout 和取消回退增加 fake provider 测试，确保取消不污染下一轮 history/Memory。
5. 为语音输入插入增加 focus 丢失、剪贴板失败、粘贴失败和恢复剪贴板的跨平台契约测试。

不建议直接复制 OpenLess 的线性插值算法或阈值数值到所有设备；应复用它的“集中归一化、显式状态、代次校验、纯逻辑测试”方法，数值则通过桌宠自身设备矩阵和实际录音样本校准。
