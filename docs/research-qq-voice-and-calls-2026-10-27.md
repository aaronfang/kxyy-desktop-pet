# QQ 语音回复与实时通话可行性研究（2026-10-27）

## 1. 结论

**语音消息可以作为近期功能；QQ 原生电话有可研究的实现路线，但尚不能承诺当前 Mac 开箱即用。**

| 用户体验 | 可行性 | 当前证据与缺口 |
| --- | --- | --- |
| 主人发文字，元元回 QQ 语音条 | 高，建议先做 | OneBot `record` + NapCat 音频上传/转换已有源码；桌宠已有 TTS。当前 Mac 的实际转换、发送、手机播放尚未测试 |
| 主人发 QQ 语音，元元理解并回复 | 高，可接在语音回复之后 | NapCat 有 QQ 语音转写扩展，也可下载音频接桌宠已有本地 ASR；需要增加入站媒体处理 |
| 主号通过 QQ 电话与元元实时交流 | 技术上有先例，Mac 仍属实验 | Cortico 电话扩展作者报告 Linux 实测成功；底层 KoishiRTC 已有 macOS 实现，但作者明确没有 Mac 实机验收 |

**对当前机器的有利发现**：已安装 QQ 为 `7.0.2-53644`，AVSDK 库 SHA-256 与 KoishiRTC 的 Mac 审计画像完全一致。这消除了一个版本前提，不能证明签名启动、NapCat 插件加载、音频权限和双向通话成功。[S8][S9]

本轮仅研究并做只读文件检查，没有安装驱动、加载原生扩展、重启服务、发 QQ 消息、提交或推送。

## 2. 调查范围与证据口径

固定源码快照，避免把后续上游变化当成本次结论：

| 项目 | 快照 | 用途 |
| --- | --- | --- |
| OneBot 11 | `d4456ee706f9ada9c2dfde56a2bcfc69752600e4` | 消息段和公共动作规范 |
| NapCatQQ | 安装版本 `v4.18.41`，提交 `859eb530c5801577633c2c3ae871d23586edf281` | 本机所用协议实现 |
| Coopanion | `fcb735ec6761c670bf21f8dca95d485cf9807172` | 原研究对象；QQ 具体能力需继续追溯 Cortico/扩展 |
| Cortico | `ee6fb3e0b71d0c947942d855929f21eb08448ddd` | QQ 语音收发实际用法 |
| cortico-world-phone | `1688aabd97423349a05fc48a59a38e62206a24c8`，源码包版本 `0.4.0` | QQ 电话接入、音频和会话状态 |
| KoishiRTC | `debcea3aca035b6b81ea87fc380096ad77d4dbc8` | 真正的 QQ 通话控制与连续音频桥 |

“源码已有”“作者报告实测”“本机只读检查”“本机端到端通过”分别陈述。此次没有本机媒体端到端结果。

## 3. QQ 语音回复：可以复用现有桌宠能力

### 3.1 协议链路已经存在

OneBot 11 定义 `record` 语音段，可通过 `send_private_msg` 发给固定主人；音频来源支持本地文件 URI、URL、Base64。它是发送一条语音消息，无须建立通话。[S1][S2]

NapCat 4.18.41 的发送链会检测/转换 SILK，再上传 QQ PTT 文件并建立语音元素。因此桌宠可以先生成 WAV/MP3，交给协议端做 QQ 格式转换。Cortico 已采用 `base64://` 的 `record` 段，且将语音独占一条消息。[S3][S6]

桌宠已有 [TTS 代理](../src-tauri/src/api.rs) 的 `/api/tts`：按设置选择火山或本地语音后端，返回音频。QQ 无须另配一套人格或声音模型；应从音频合成结果接出，避免调用会让桌面扬声器播放的前端朗读入口。[S11]

建议链路：

```text
主号文字 → 现有 QQ 人格 / Memory / 模型回复
         → 当前 TTS → App 管理的临时音频文件
         → NapCat record → 主号收到元元语音条
```

### 3.2 当前 Mac 仍有一个必须先验证的媒体前提

NapCat 的 `can_send_record` 在该版本直接返回 `yes: true`，并非实际编码测试。不能据它显示成功就宣称语音可用。[S4]

其 FFmpeg 选择逻辑优先使用存在的原生 addon；addon 加载失败会报错，并不保证自动回退。命令行转换则明确要求 `ntsilk_s16le` 编码器。[S5]

本机只读检查：

- 已有 `napcat/native/ffmpeg/ffmpegAddon.darwin.arm64.node`，但本轮没有加载或试转换。
- `/opt/homebrew/bin/ffmpeg -hide_banner -encoders` 成功执行，列表中没有 SILK 编码器。因此仅指定现有 Homebrew FFmpeg，不能认为能完成 NapCat 所要求的 SILK 编码。
- [既有安装记录](qq-onebot-setup.md)记载：可选封包 Hook 曾触发 QQ Helper 签名崩溃，停用后文字可用。封包 Hook 与 FFmpeg addon 是不同组件；不能由前者推断后者失败，也不应为媒体试验直接恢复已停用的 Hook。

下一阶段先用一段短测试音做隔离转换，再验证手机播放；通过后才扩展产品功能。

### 3.3 建议的产品行为

设置增加“QQ 回复方式：文字 / 语音 / 文字和语音”，初始仍为文字。沿用现有“启动 QQ 自动回复”开关托管连接与所需服务，不增加独立 `.command` 启动脚本。

人格、主人昵称、记忆分档、模型和声音沿用桌宠设置。切换参数后，新轮次使用新快照，旧轮次取消，防止旧人格音频晚到。普通对话继续整理 Memory；明确保存仍以真实 SQLite 结果为准。

实现时需处理这些现有约束：

- [QQ 会话控制器](../src/ai/qq-private-chat.js)目前有 30 秒整轮超时；[Rust 接入](../src-tauri/src/qq.rs)有草稿有效期和发送回执期限。长时间 TTS 不能直接塞进旧期限，应区分生成、合成、发送阶段，并继续保持有界等待与取消。
- 当前 WebSocket 消息/帧上限为 64 KiB。直接照搬 Base64 音频容易超限。本机优先用 App 自有临时文件，且路径对 NapCat 进程可读；不让模型自由指定文件路径或 URL。
- 同时限制队列、字数、音频时长/大小和临时文件寿命；关闭服务、取消、失败、重启后的遗留文件都要清理。保留文件直到协议端完成读取，不能写完即删。
- TTS 在尚未发送前明确失败时可以降级文字；发送结果不明时不要盲目重发。文字与语音两条发送分别记结果，记忆整理只做一次。
- **OneBot 成功回执代表发送成功，不代表主人播放/听见。** QQ 语音消息不具有桌宠 Worklet 的可听完成回执，不能伪造该证据。

## 4. 主人发送 QQ 语音：两条可选识别路线

目前 [owner_text](../src-tauri/src/qq.rs)仅接受绑定主人的纯文字私聊，遇到 `record` 等非文字段直接拒绝。因此现有版本不回复语音消息是实现范围所限。

| 路线 | 处理方式 | 取舍 |
| --- | --- | --- |
| QQ 自带语音转写 | NapCat `fetch_ptt_text(message_id)` → QQ `translatePtt2Text` → 文字 | 改动较小，与 Cortico 路线一致；依赖 QQ 转写服务，不是本地 ASR |
| 本地识别 | 获取并解码音频 → 16 kHz 单声道 PCM16 WAV → 桌宠内部 `/asr` | 复用已有 Whisper/SenseVoice；需要本地语音服务、受控文件读取和格式转换 |

NapCat 已有 `fetch_ptt_text` 和 `get_record` 实现；Cortico 仅在动作不存在时尝试另一协议端的 `voice_msg_to_text`，不会把普通超时当成需要切换接口。[S6][S7]

桌宠 [common.py](../scripts/local-realtime/common.py)已有内部 `/asr`：使用共享 secret，输入为 Base64 WAV，要求 16 kHz、单声道、16-bit、最长 30 秒；请求体最多 4 MiB，ASR admission 为 1，返回文字最多 512 字符。它可作为复用点，当前 QQ 尚未接入；这是整段识别接口，不能作为电话连续音频的现成入口。[S11]

NapCat `get_record` 转换结果还可能包含整段 Base64；现有 64 KiB WebSocket 上限会受影响。实现前须选定受控的媒体获取方式或单独有界通道，不能简单取消大小限制。[S7]

建议先支持单条主人私聊语音，识别失败明确提示，保持同一人格/Memory 流程。明确“请记住”在转写有歧义时先确认，避免将识别错误当作已确认事实保存。普通整理仅使用已接受的转写与实际回复，原始音频默认短期处理后删除。

## 5. QQ 原生电话：已有桥，Mac 仍需隔离验证

### 5.1 不属于当前 OneBot 消息接入

审阅的 OneBot 11 公共 API 和 NapCat 4.18.41 动作表没有提供完整的拨号、接听、挂断、连续 PCM 收发接口。`record` / `get_record` 解决语音条，不能把它们拼成 QQ 原生电话。[S2][S12]

Coopanion 生态中的 `cortico-world-phone` 是真实 QQ 电话扩展，但实际通话依赖另一个 QQ AVSDK 桥进程。作者报告其 Linux + NapCat 路线已完成来电、接听、双向音频、主动拨号和挂断；Windows 路线未完全验证。单装这个扩展不会让现有桌宠获得电话。[S8]

它本身的 SenseVoice + MiniMax 是那套产品的选择，不是 QQ 的硬要求。我们可复用桌宠现有 ASR、TTS、人设和 Memory，但需要独立的电话传输适配。

### 5.2 进一步追溯：上游已经有 Mac 代码

KoishiRTC 的 [Mac 说明][S9]给出了：

- QQ 自带 Electron/AVSDK + NapCat 原生会话控制插件 + 独立 AV Host。
- QQ 7.0.2-53644 的 arm64/x64 精确库指纹和控制画像。
- 两条不同的 BlackHole 虚拟音频路线、PortAudio 工作进程；一个方向收 QQ 声音，一个方向向 QQ 麦克风送入合成音频。
- 来电、接听、拒接、挂断、拨号与音频路由校验代码。

**上游明确写明没有 Mac 实机**：签名启动、NapCat 登录、TCC 权限和真实双向声音均未验收。Mac 安装器的本地插件 bootstrap 针对 NapCat 4.18.13 的结构核对；我们使用 4.18.41，需重新检查兼容性。[S9]

本机只读核对结果：

```text
QQ version: 7.0.2-53644
AVSDK: /Applications/QQ.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib
SHA-256: 8dcddc9ade6120ba1fecb7f8961d401dded8c4881ce3e12b5a023465089c64c6
与 KoishiRTC Mac 画像匹配: 是
```

没有运行它的安装器/Host、没有安装 BlackHole，也没有验证 QQ 接受合成音频。复制 `.app` 也不保证账号数据隔离：上游说明同 bundle 标识仍可能访问现有 QQ 容器，试验应使用独立 macOS 用户或独立测试环境。[S9]

### 5.3 接到桌宠需要做什么

建议按音频传输边界接入，而不是让电脑麦克风和扬声器绕一圈：

```text
QQ 来电 → AVSDK 控制桥 → 校验绑定账号与主人 → 通话状态机
QQ 远端音频 → 独立音频桥 → 重采样/分句 → 现有 ASR / 人格 / Memory / LLM
现有 TTS PCM → 独立音频桥 → QQ 虚拟麦克风 → 主人
```

当前桌宠实时通话从 WebView 麦克风获取输入、向 AudioContext 输出；已有 AI 通话不等于已有 QQ 电话传输。需要将输入/输出接到桥，并保留现有有界队列、打断、取消和会话代际隔离，不能直接把 QQ 音频当成本地麦克风播放。

电话会话也需区分“拨号命令提交”“QQ 已接通”“本地音频已排空”“远端实际听见”。KoishiRTC 的设备播放回执本身不能证明远端听见，原生状态成功也不能替代声音验收。[S10]

通话记忆应继承 [Memory 路线图](roadmap-memory-brain.md)的分档与证据边界；不能把仅合成/排队、尚未确认输出的正文全部当作已经说过。长检索不得卡住实时音频路径。

### 5.4 不推荐直接移植的做法

电话扩展另有“点 QQ 界面 + 虚拟声卡”的备选桥，但作者记录它不能可靠确定来电者，点击接听后还存在未确认就报告成功的问题；其 Linux 界面实现也未走完端到端。[S13]

这与我们“只给主人号服务”的要求冲突。首个电话实验应优先核对原生控制桥，而不是做一套只按窗口坐标接听的功能。

## 6. 建议推进顺序与验收

| 阶段 | 最小交付 | 通过条件 |
| --- | --- | --- |
| A：媒体兼容性试验 | 短音频 → QQ 语音格式 → 测试私聊 | Mac 实际转换成功，主号手机能播放；现有文字、登录、启停不回归 |
| B：QQ 语音回复 | 设置中选择文字/语音/两者，复用现有人格与声音 | 隐藏窗口也能回语音；切换人格/昵称/声音生效；关闭即停止；TTS 失败降级、结果不明不重复发送；普通整理和明确保存仍正确 |
| C：主人语音输入 | 先选定 QQ 转写或本地 ASR，保留另一条为后续选项 | 正常/空/过长/撤回/识别失败均有确定行为；陌生人和群聊不进入处理；Memory 分档正确 |
| D：Mac 电话隔离原型 | 固定版本 AVSDK 桥 + 两条独立音频路线 | 真实主号来电身份、接听、双向声音、打断、双方挂断、掉线/设备故障恢复；不能只验命令回执 |
| E：电话产品化 | 设置内管理桥和服务，统一退出 | 单开关启动依赖、未登录提示、关闭清理托管进程；不接管外部 QQ；无脚本操作要求；每个目标 OS 单独验收 |

建议先 A → B → C，再决定是否投入 D。Mac 路线值得做原型，因为本机 AVSDK 指纹已匹配；尚不能绕过 NapCat 兼容性、签名、TCC 和虚拟音频的真实验证。如果 Mac 原型受阻，作者已有实测的 Linux 电话桥可作为另一部署选择，但会增加运行环境并涉及同一 QQ 账号登录位置的迁移，不能直接叠加到当前在线实例上。[S8][S9]

KoishiRTC 相关文件声明 GPL-3.0-only，电话 World 为 MIT。研究借鉴与后续打包/复制代码分开评估；优先通过独立进程协议对接，不能默认将桥源码复制进桌宠后继续按原项目许可发布。[S8][S9]

## 7. 一手资料

- [S1：OneBot 11 语音消息段](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md#语音)
- [S2：OneBot 11 公共 API](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md)
- [S3：NapCat 4.18.41 PTT 创建/上传](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/api/file.ts)；[音频编码辅助](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/helper/audio.ts)
- [S4：NapCat can_send_record 实现](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/system/CanSendRecord.ts)
- [S5：NapCat FFmpeg 适配器选择](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/helper/ffmpeg/ffmpeg-adapter-factory.ts)；[SILK 命令行编码](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/helper/ffmpeg/ffmpeg-exec-adapter.ts)
- [S6：Cortico QQ 语音收发说明](https://github.com/Pal-AI-Lab/Cortico/blob/ee6fb3e0b71d0c947942d855929f21eb08448ddd/src/worlds/qq/README.md)；[消息段构建](https://github.com/Pal-AI-Lab/Cortico/blob/ee6fb3e0b71d0c947942d855929f21eb08448ddd/src/worlds/qq/normalize.ts)
- [S7：NapCat QQ 转写调用](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/msg/FetchPttText.ts)；[get_record 转换与返回值](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/file/GetRecord.ts)
- [S8：cortico-world-phone README、作者验证范围与许可](https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/README.md)；[Linux 路线](https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/docs/route-a-cloud-linux-napcat.md)
- [S9：KoishiRTC Mac 后端与验证边界](https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/docs/qq-macos.md)；[精确原生画像](https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/bridge/qq/napcat-plugin/native-profile.mjs)；[平台矩阵](https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/docs/platforms.md)
- [S10：KoishiRTC 音频路线、队列和播放回执边界](https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/docs/audio-setup.md)
- S11：本仓库 [TTS 代理](../src-tauri/src/api.rs)、[内部 ASR / 本地语音公共实现](../scripts/local-realtime/common.py)、[实时语音前端](../src/ai/realtime.js)、[QQ 接入](../src-tauri/src/qq.rs)、[QQ 会话控制](../src/ai/qq-private-chat.js)。依据当前未提交工作区，不以旧主干代码代替。
- [S12：NapCat 4.18.41 动作表](https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/router.ts)
- [S13：电话扩展界面桥的未验证项和身份缺口](https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/docs/route-b-ui-driven.md)

[S1]: https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md
[S2]: https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md
[S3]: https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/api/file.ts
[S4]: https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/system/CanSendRecord.ts
[S5]: https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-core/helper/ffmpeg/ffmpeg-adapter-factory.ts
[S6]: https://github.com/Pal-AI-Lab/Cortico/blob/ee6fb3e0b71d0c947942d855929f21eb08448ddd/src/worlds/qq/README.md
[S7]: https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/msg/FetchPttText.ts
[S8]: https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/README.md
[S9]: https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/docs/qq-macos.md
[S10]: https://github.com/Touch-Night/KoishiRTC/blob/debcea3aca035b6b81ea87fc380096ad77d4dbc8/docs/audio-setup.md
[S11]: ../src-tauri/src/api.rs
[S12]: https://github.com/NapNeko/NapCatQQ/blob/859eb530c5801577633c2c3ae871d23586edf281/packages/napcat-onebot/action/router.ts
[S13]: https://github.com/biliye/cortico-world-phone/blob/1688aabd97423349a05fc48a59a38e62206a24c8/docs/route-b-ui-driven.md
