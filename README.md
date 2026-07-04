# 元元桌宠 (kxyy-desktop-pet)

基于 [webmeji](https://github.com/lars-rooij/webmeji) 动画逻辑改造的 **macOS / Windows 跨平台桌面宠物**，用 **[Tauri](https://tauri.app) 2** 封装（前端 Web 动画 + Rust 主进程）。桌宠会在屏幕上走动、坐下、跳舞、攀爬屏幕边缘，可拖拽、可抚摸，右键或托盘可切换形象。

除动画外，还内置 **AI 聊天** 能力：通过全局快捷键唤出聊天气泡，与「元元」对话（DeepSeek 文字模型），支持发图看图（通义千问 VL）、语音朗读与**实时语音通话**（可切换火山云端 / 本地模型 / CosyVoice）、表情包回复与自定义人设。朗读与通话共用一套语音后端，并支持 **0–200% 播放音量**。所有 AI 服务 Key 只保存在本机，请求经内置本地代理直连服务商或本机模型，不经第三方。

当前内置两套形象：**赛博元元**（`kxyy-cyber`）与 **苗疆元元**（`kxyy-miaojiang`，默认）。应用图标为苗疆元元头部特写，缩小后仍可辨认。macOS 上为菜单栏托盘应用，**不占用 Dock**。

> 相比早期 Electron 版本：安装包由 ~70MB 降至 **~4MB**，内存占用大幅下降（Tauri 复用系统 WebView，无独立 Chromium）。

## 环境要求

- [Node.js](https://nodejs.org)（用于 Tauri CLI）
- [Rust](https://www.rust-lang.org/tools/install)（`rustc` / `cargo`）
- 平台依赖：
  - **Windows**：WebView2 运行时（Win10/11 一般自带）+ MSVC 生成工具
  - **macOS**：Xcode Command Line Tools
- AI 聊天所需的服务 Key（可选，不填也能正常使用桌宠动画）：
  - **DeepSeek API Key**：文字聊天必填；本地语音对话的 ASR 后文本理解也用（[申请](https://platform.deepseek.com)）。
  - **通义千问 / DashScope Key**：发图看图、CosyVoice（通义云）选填（[申请](https://bailian.console.aliyun.com)）。
  - **火山引擎**（语音后端选「火山」时）：TTS Key、实时语音 App ID / Access Key、音色 `voice_id`。
  - **本地语音**：需本机 Python 环境；macOS 选 Qwen3-TTS 时应用会自动配置运行时；Windows + NVIDIA 可选 IndexTTS-2 / CosyVoice3（安装包可勾选配置，或运行 `scripts/windows/setup-gpu-voice.cmd`）。本地克隆需提供 10–20s 参考音频。
  - 首次实时通话需允许麦克风权限。

## 运行

```bash
npm install
npm run dev        # 开发模式（tauri dev）
```

启动后桌宠出现在屏幕底部，**菜单栏（macOS）/ 系统托盘（Windows）**会出现一个图标（macOS 不显示 Dock 图标）：

- **显示 / 隐藏桌宠**
- **聊天（Ctrl+Shift+Space）**：唤出 / 收起 AI 聊天气泡
- **选择形象**：赛博元元 / 苗疆元元
- **大小**：100% / 125% / 150% / 200%
- **所在屏幕**：多显示器时可选择固定在某块屏幕，或设为「自动（当前屏幕）」跟随启动时所在屏幕
- **设置…**：打开聊天设置窗口（Key、语音后端、模型、人设、头像、快捷键、气泡尺寸、音量等）
- **开机自启**
- **退出**

也可以直接**右键点击桌宠**弹出同样的菜单。桌宠之外的区域鼠标可正常穿透，不影响操作其它软件。

## 交互

- **拖拽**：按住桌宠拖动，松手后它会掉落到屏幕底部。
- **抚摸**：鼠标悬停在桌宠上会触发抚摸动画。
- **自动行为**：走路、坐、旋转、跳舞、思考，以及跳到屏幕左/右/上边缘攀爬、悬挂、坠落。

> 点击穿透说明：Tauri 没有 Electron 的「鼠标事件转发」，故穿透态下由前端低频轮询光标坐标做像素级命中判定，仅当指针接近桌宠时才切回可交互态，桌宠外的透明区域始终穿透。

## AI 聊天

按 **`Ctrl+Shift+Space`**（可在设置中改）或点托盘「聊天」，在桌宠上方唤出聊天气泡，与「元元」对话；再按一次或点窗口外收起。

- **文字对话**：由 DeepSeek 驱动，支持流式输出；可在设置里切换 `deepseek-chat`（快）/ `deepseek-reasoner`（会思考）与采样温度。
- **发图看图**：附带图片时用通义千问 VL 识图（需填通义 Key）。
- **语音朗读 / 实时通话**：朗读与通话共用「语音后端」，在设置里切换：
  | 后端 | 说明 |
  | --- | --- |
  | **火山引擎 API** | 云端 TTS + 端到端实时语音；需火山 Key / App ID / Access Key / `voice_id` |
  | **本地 Qwen3-TTS** | macOS 推荐；保存后自动配置 venv、依赖与模型（首次需网络），零样本克隆参考音频，不消耗火山 token |
  | **CosyVoice（通义云）** | 本机 Whisper + DeepSeek，TTS 走通义云端；需通义 Key 与 CosyVoice 音色 id |
  | **IndexTTS-2 / CosyVoice3** | Windows + NVIDIA 本地开源模型；安装包可勾选配置，或运行 `scripts/windows/setup-gpu-voice.cmd` |
- **播放音量**：设置里「AI 语音播放音量」0–200%（100% 为原音量），朗读与通话共用。
- **实时语音通话**：聊天气泡输入框最左侧的电话按钮开启 / 挂断；经本地 WebSocket 桥接上游（火山或本机 Python 服务），复用元元人设与克隆音色，支持打断。通话中文字输入、发图与表情库会暂时锁定。macOS 首次使用会弹出麦克风权限提示。
- **表情包**：元元会按情绪回贴纸；也可点「表情库」手动发送。
- **人设 / 观众画像**：在设置里填昵称、关系、想让它记住的事、暗号梗等，对话时注入，让元元更懂你。

> **隐私**：所有 Key、观众画像、头像、参考音频路径仅写入本机配置目录的 `settings.json`（Windows 为 `%APPDATA%\<应用ID>\`），**不进仓库、不上传**；请求由内置本地代理（Rust `api.rs` / `realtime.rs` / `voice_service.rs`）直连各服务商或本机模型，不经任何第三方。内置人设语料经 XOR 加密后编译进 Rust 二进制，运行时由 `/api/assets` 下发，**安装包内不含明文 `persona-assets.js`**。

### 配置

托盘菜单选 **设置…** 打开设置窗口，按分区填写：AI 服务 Key、语音服务（后端 / 参考音频 / 音量）、模型与人格、观众画像、头像与外观、快捷键与气泡尺寸。保存后即时生效（快捷键会重注册、聊天窗口按新尺寸重定位；切换本地语音后端会自动启动 / 重启本机语音服务）。

### 本地语音说明

- **零样本克隆**：本地模型不训练音色，填入 10–20s 单人清晰参考录音（及可选文案）后，**保存并重启语音服务**（切换后端或重开 App）即按此录音克隆。
- **macOS**：仅提供 Qwen3-TTS；运行时落在 `~/Library/Application Support/com.aaronfang.kxyydesktoppet/voice-runtime`，也可手动执行 `scripts/macos/setup-qwen3-tts.sh`。
- **Windows + NVIDIA**：IndexTTS-2 / CosyVoice3 模型体积较大（数 GB～十余 GB），需网络与足够磁盘；安装程序 POSTINSTALL 可勾选，或手动运行 `scripts/windows/setup-gpu-voice.cmd`。
- 设置页底部会显示本地服务状态与日志；开发模式也可直接使用仓库内 `scripts/local-realtime/`。

## 打包

打包前会自动加密人设语料并临时移走明文文件，避免语料原文打进安装包：

```bash
npm run encrypt-assets   # 单独执行：将 persona-assets.js 加密为 src-tauri/assets/persona-assets.enc
npm run build            # 当前平台（含 encrypt → strip → tauri build → restore）
npm run build:win        # Windows 安装包 (NSIS)
npm run build:mac        # macOS dmg
```

产物在 `src-tauri/target/release/bundle/` 目录。

> **开发注意**：`npm run dev` 前也会自动执行 `encrypt-assets`；若 `sync-ai` 后更新了语料，需重新加密。`persona-assets.enc` 已加入 `.gitignore`，CI 与本地打包时现场生成。
>
> 图标：`src-tauri/icons/` 由 `npx tauri icon <方形png>` 生成；仓库 `build/icon-square.png` 为图标源（苗疆元元头部特写）。

## 目录结构

```
src/                  前端（渲染层，随前端一起打包）
  index.html
  styles.css
  pet-config.js       角色配置与注册
  pet-engine.js       动画引擎（源自 webmeji 的 Creature）
  app.js              启动、点击穿透命中判定、右键菜单联动（Tauri IPC）
  assets/pets/        两套角色素材：<角色id>/<动作>/<动作>_NN.png
  chat.html/js/css    AI 聊天气泡窗口（流式对话、图片附件、表情库、实时语音通话、音量）
  settings.html/js/css 设置窗口（Key、语音后端、模型、人设、头像、快捷键、气泡尺寸、音量）
  ai/                 复用自上游的纯逻辑/语料模块
    persona.js        人设与提示词组装（运行时从 /api/assets 拉取语料）
    persona-assets.js 人设语料（开发用明文；打包时加密嵌入，不随安装包分发）
    stickers.js       表情系统（清单加载与情绪匹配）
    tts.js            语音合成（火山 / 本地 / CosyVoice 等后端）
    realtime.js       实时语音通话前端（麦克风采集、下行播放、打断）
    voice-volume.js   朗读与通话共用的播放音量增益
    pcm-worklet.js    麦克风 PCM 重采样 AudioWorklet（16k s16le）
    avatars.js        默认头像
  stickers/           表情包清单 stickers.json + GIF 素材
src-tauri/            Rust 主进程
  src/lib.rs          透明置顶穿透窗口、托盘菜单、开机自启、设置持久化、全局快捷键、聊天/设置窗口管理、IPC 命令；macOS 隐藏 Dock
  src/api.rs          本地 AI 代理：聊天 / TTS / 语料下发（/api/assets）
  src/realtime.rs     本地实时语音 WS 桥接（前端 ↔ 火山或本机语音服务）
  src/voice_service.rs 本地 Python 语音服务生命周期（启动 / 重启 / 日志）
  src/persona_assets.rs 人设语料 XOR 解密（编译期嵌入 persona-assets.enc）
  assets/             persona-assets.enc（encrypt-assets 生成，gitignore）
  src/main.rs         入口
  Info.plist          macOS：麦克风用途说明、LSUIElement（隐藏 Dock）
  windows/hooks.nsh   Windows 安装程序钩子（可选 GPU 本地语音配置）
  tauri.conf.json     窗口 / 打包 / 图标配置（含 local-realtime 脚本资源）
  capabilities/       前端权限
  icons/              应用图标
shared/
  roster.json         角色清单（主进程托盘与前端共用，编译期嵌入 Rust）
scripts/
  sync-assets.mjs     从 web 工程同步角色素材到 src/assets/pets
  sync-ai.mjs         从 web 工程同步 AI 逻辑模块、人设语料与表情素材
  encrypt-assets.mjs  将 persona-assets.js 加密为 src-tauri/assets/persona-assets.enc
  bundle-assets.mjs   打包前 strip / 打包后 restore 明文语料文件
  local-realtime/     本地语音 Python 服务（Qwen3-TTS / CosyVoice / IndexTTS-2 等）
  macos/setup-qwen3-tts.sh   macOS Qwen3-TTS 运行时自动配置
  windows/setup-gpu-voice.*  Windows + NVIDIA 本地模型可选安装
```

## 扩展 / 同步新角色

素材结构与上游 web 工程 (`kxyy_ai_clone`) 完全一致，方便持续扩展：

1. **同步素材**（默认从同级的 `kxyy_ai_clone` web 工程拉取）：
   ```bash
   npm run sync-assets
   # 或指定源目录
   node scripts/sync-assets.mjs /path/to/webmeji
   ```
2. **注册新角色**：
   - 在 `shared/roster.json` 的 `pets` 里加一行 `{ "id": "新id", "label": "显示名" }`。
   - 在 `src/pet-config.js` 用 `registerPet("新id", { frames: {...}, ... })` 配置帧数与节奏（帧数与上游 `config.js` 保持一致即可）。

每个角色需要的动作目录：`walk / sit / dance / trip / forcethink / pet / drag / falling / fallen / climbSide / climbTop / hangstillSide / hangstillTop / jump`。

### 同步 AI 逻辑与表情

AI 的纯逻辑模块（人设、TTS、表情系统）与表情素材同样与上游 web 工程一致，可一键同步：

```bash
npm run sync-ai
# 或指定源目录
node scripts/sync-ai.mjs /path/to/kxyy_ai_clone
```

会把上游的 `persona.js` / `tts.js` / `persona-assets.js` / `stickers.js` 同步到 `src/ai/`，并把表情清单与 GIF 拷到 `src/stickers/`（自动改写为包内相对路径）。同步语料后请执行：

```bash
npm run encrypt-assets
```

> 若上游改动了 `/api/chat` 的请求 / 响应契约，需手动同步更新 `src-tauri/src/api.rs` 与 `src/chat.js`。

## 发布

版本号需在 **`package.json`**、**`src-tauri/tauri.conf.json`**、**`src-tauri/Cargo.toml`**（及 `Cargo.lock`）四处保持一致。

推送形如 `v0.2.5` 的 tag 会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)，自动构建并上传到 GitHub Release：

- **Windows**：NSIS 安装包（`.exe`）；安装时可勾选配置 GPU 本地语音模型
- **macOS**：Apple Silicon（`aarch64`）与 Intel（`x64`）各一份 `.dmg`；菜单栏托盘应用，不占用 Dock

也可在 GitHub Actions 页面手动 **workflow_dispatch** 重跑。

### 更新日志（v0.2.5）

- 修复表情包面板：补全 `stickerGridBuilt` 声明，避免打开表情库时报错

### 更新日志（v0.2.4）

- 支持多语音后端：火山引擎、本地 Qwen3-TTS、CosyVoice（通义云）、IndexTTS-2 / CosyVoice3（Windows + NVIDIA）
- 朗读与实时通话共用后端；本地模型零样本克隆参考音频
- AI 语音播放音量 0–200%（朗读与通话共用）
- macOS 自动配置 Qwen3-TTS 运行时；Windows 安装包可选 GPU 本地模型配置

## 致谢

动画引擎源自 Lars de Rooij 的 [webmeji](https://webmeji.neocities.org)。
