# 元元桌宠

一个会在桌面散步、攀爬、陪你聊天的跨平台桌宠。支持 **Windows / macOS**，基于 **Tauri 2 + Rust + WebView**。

当前正式版：[`v0.2.47`](https://github.com/aaronfang/kxyy-desktop-pet/releases/tag/v0.2.47)

## 先用起来

1. 从 [GitHub Releases](https://github.com/aaronfang/kxyy-desktop-pet/releases/latest) 下载对应安装包。
2. 安装并启动；macOS 在菜单栏、Windows 在系统托盘找到元元图标。
3. 按 `Ctrl+Shift+Space` 打开聊天；不配置 AI 也能正常使用桌宠动画。

| 平台 | 安装包 | 备注 |
|---|---|---|
| Windows x64 | `.exe`（NSIS） | Win10/11 通常已包含 WebView2 |
| macOS Apple Silicon | `aarch64.dmg` | 适用于 M1/M2/M3/M4 系列 |
| macOS Intel | `x64.dmg` | macOS 上只显示菜单栏图标，不占 Dock |

## 它能做什么

| 能力 | 当前状态 |
|---|---|
| 桌宠动画 | 走路、坐下、跳舞、拖拽、抚摸、攀爬、悬挂和坠落 |
| 两套形象 | 苗疆元元（默认）和赛博元元，可从托盘或右键菜单切换 |
| AI 聊天 | DeepSeek 云端或 Ollama 本地模型，支持流式文字回复 |
| 图片与表情 | 通义千问 VL 看图、自动或手动发送表情包 |
| 语音 | 文字朗读和实时通话，共用火山、CosyVoice 或本地 Qwen3-TTS 后端 |
| 长期记忆 | Memory v3/v3.1：事实、经历、约定、关系图和可管理的选择性召回 |

## 常用操作

| 操作 | 方法 |
|---|---|
| 打开或收起聊天 | `Ctrl+Shift+Space`，也可在设置里改快捷键 |
| 移动桌宠 | 按住桌宠拖动，松手后自动落到屏幕底部 |
| 抚摸 | 将鼠标停在桌宠上 |
| 打开菜单 | 右键桌宠，或点击菜单栏/系统托盘图标 |
| 调整形象、大小和屏幕 | 使用右键/托盘菜单 |

桌宠以透明置顶窗口运行。透明区域保持鼠标穿透，只有指针接近桌宠可见像素时才切回可交互状态。

## 配置 AI

打开托盘菜单的 **设置…**。先选择你想走的路径：

| 目标 | 最少需要 |
|---|---|
| 只用桌宠动画 | 不需要 Key 或模型 |
| 云端文字聊天 | DeepSeek API Key |
| 本地文字聊天 | 安装 [Ollama](https://ollama.com/download)，再从设置页下载模型 |
| 发图看图 | DashScope / 通义千问 Key |
| 语音朗读或通话 | 选择下表中的一个语音后端 |

### 文字和图片

- **DeepSeek**：默认文字服务，支持 `deepseek-v4-flash` / `deepseek-v4-pro` 和独立思考开关。
- **Ollama**：本地文字服务；默认推荐 `qwen3:14b`，也可使用 `qwen3:8b`、`qwen3:32b` 或其它 tag。
- **通义千问 VL**：发送图片时使用，需要 DashScope Key。
- **播放音量**：朗读与通话共用 `0–200%` 音量设置，`100%` 为原始音量。

### 语音后端怎么选

| 后端 | 适合 | 需要 |
|---|---|---|
| 火山引擎 | 配置简单的云端朗读与端到端实时语音 | TTS Key、实时语音 App ID / Access Key、`voice_id` |
| CosyVoice | 云端克隆音色 + 本地 ASR/文字模型编排 | DashScope Key、CosyVoice 音色 ID |
| Qwen3-TTS 本地 | 不消耗云端 TTS token、使用本机克隆音色 | Python 环境、10–20 秒参考音频 |

实时通话入口在聊天输入框最左侧的电话按钮。通话中会暂时禁用文字输入、图片和表情库；第一次使用需要允许麦克风权限。

## 本地 Qwen3-TTS

### 1. 准备参考音频

使用 10–20 秒、单人、清晰、背景噪声较少的录音。设置参考音频和可选文案后，保存并重启语音服务。

苗疆元元的本地 Qwen3-TTS 设置页还提供 6 个发布音色：自动评分最高的 5 个参考音，以及当前最早的内置旧基线。选择菜单项后 Python 服务会在下一句合成前热加载，不会重启服务；手动填写参考音频会覆盖菜单选择。发布包只包含这 5 个新音频、旧 `ref.wav/ref.txt` 和清单，75 条试听样例及其余候选只保留在本地忽略目录。

### 2. 安装运行时

| 平台 | 运行方式 | 默认模型 |
|---|---|---|
| macOS Apple Silicon | App 自动配置 `mlx-audio`；也可运行 `scripts/macos/setup-qwen3-tts.sh` | Qwen3-TTS Base |
| Windows | 运行 `scripts/windows/setup-qwen3-tts.cmd` 创建 `.venv-qwen3`；CUDA 优先使用 `faster-qwen3-tts` | `Qwen3-TTS-12Hz-1.7B-Base` |
| Linux | 官方 PyTorch `qwen-tts` | `Qwen3-TTS-12Hz-1.7B-Base` |

模型默认从 Hugging Face 官方源下载。下载超过 180 秒时，App 会继续显示“下载/加载中”并保持健康探测；模型就绪后自动恢复。只有显式设置 `hfEndpoint` 才会改用自定义镜像。

### 3. 了解流式边界

- CosyVoice、受支持的 macOS MLX Qwen，以及安装了 `faster-qwen3-tts==0.3.2` 的 Windows CUDA Qwen 可协商生成期 PCM 流式下发。
- Windows 流式路径固定使用公开的 `generate_voice_clone_streaming(parity_mode=False)` CUDA-graph 路径和 24-step provider chunk；启动期完整耗尽一次同模式短预热，依赖、CUDA smoke、预热或 API 校验不通过时回退官方 `qwen-tts` 整句合成。Linux 暂时仍为整句路径。
- 当前短预热主要消除运行时冷启动延迟，首次正式回复的克隆音色仍可能比后续句子波动；音色一致性将用独立冷启动听测继续优化，不属于本版已解决范围。
- 本地/CosyVoice 默认使用 Whisper 句尾识别；SenseVoiceSmall INT8 是可选实验后端。
- Silero VAD 仍是默认关闭的 shadow 实验，不参与线上打断、endpoint 或 ASR 决策。

实现细节、验收边界和后续计划见 [实时语音路线图](docs/roadmap-realtime-voice.md)。

### RTX 50 系报 `no kernel image`

原因：重新安装 App 会保留旧 `.venv-qwen3`；旧环境中的 `torch + cu124` 能识别 RTX 50 系显卡，但不包含 `sm_120` CUDA kernel。

1. 完全退出元元桌宠。
2. 在 PowerShell 执行：

```powershell
$venv = Join-Path $env:LOCALAPPDATA "元元桌宠\scripts\local-realtime\.venv-qwen3"

& "$venv\Scripts\python.exe" -m pip install `
  --upgrade --force-reinstall `
  torch torchaudio `
  --index-url https://download.pytorch.org/whl/cu128
```

3. 验证 `sm_120` 和真实 CUDA 运算：

```powershell
& "$venv\Scripts\python.exe" -c "import torch; print(torch.__version__); print(torch.cuda.get_arch_list()); x=torch.randn((64,64),device='cuda',dtype=torch.bfloat16); print((x@x).shape)"
```

结果应包含 `+cu128`、`sm_120` 和 `torch.Size([64, 64])`。这与 Qwen 模型大小或 Hugging Face 镜像无关。

## Memory 与隐私

Memory v3/v3.1 使用本机 SQLite 保存事实、共同经历、约定、来源事件和关系边。聊天前只召回少量相关内容；设置页可以搜索、编辑、置顶、兑现、按昵称或人设清空、查看关系图，也可以创建并恢复数据库备份。恢复前会自动保存当前数据库，失败时自动回滚。数据库或模型不可用时会回退，不阻塞聊天。

| 数据 | 保存或发送位置 |
|---|---|
| Key、头像、参考音频路径、观众画像 | 本机应用配置目录的 `settings.json` |
| 长期记忆 | 同目录的 `memory-v3.sqlite3`，当前为本机明文 SQLite |
| 在线记忆巩固 | 允许记忆的会话批次直发当前配置的 DeepSeek |
| 本地记忆巩固 | 使用 Ollama 时留在本机 |
| 人设语料 | XOR 加密后编译进 Rust；安装包不含明文 `persona-assets.js` |

数据库、召回结果和统计不作为遥测上传。其它 AI 请求由内置 Rust 代理直连你选择的服务商或本机模型，不经过额外中转服务。

Memory 的现状、边界和下一阶段见 [Memory Brain 路线图](docs/roadmap-memory-brain.md)。

## 开发

### 环境

- [Node.js](https://nodejs.org)
- [Rust](https://www.rust-lang.org/tools/install)
- Windows：MSVC Build Tools + WebView2
- macOS：Xcode Command Line Tools

### 常用命令

```bash
npm install
npm run dev
```

| 任务 | 命令 |
|---|---|
| JS 确定性测试 | `npm test` |
| Python 实时服务测试 | `npm run test:python` |
| VAD 资源合同检查 | `npm run test:resources` |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` |
| Rust 检查 | `cargo check --manifest-path src-tauri/Cargo.toml` |

### 打包

| 目标 | 命令 |
|---|---|
| 当前平台 | `npm run build` |
| Windows NSIS | `npm run build:win` |
| macOS DMG | `npm run build:mac` |
| 只加密人设资源 | `npm run encrypt-assets` |

产物位于 `src-tauri/target/release/bundle/`。打包流程会生成加密语料、临时移走明文、执行 Tauri build，最后恢复开发文件。

### 目录导航

```text
src/                       前端窗口、桌宠动画与 AI 交互
  ai/                      人设、TTS、实时语音和 AudioWorklet
  assets/pets/             桌宠逐帧素材
src-tauri/src/             Rust 主进程、AI 代理、Memory、语音服务
scripts/local-realtime/    Qwen3-TTS / CosyVoice 本地 Python 服务
shared/roster.json         前后端共用的角色清单
docs/                      Memory、实时语音和角色体验路线图
```

更完整的架构、IPC、安全边界和开发约束见 [AGENTS.md](AGENTS.md)。

## 同步和扩展角色

1. 运行 `npm run sync-assets`，从同级 `kxyy_ai_clone` 同步桌宠帧素材。
2. 在 `shared/roster.json` 注册角色。
3. 在 `src/pet-config.js` 配置动作帧数；帧数必须与上游 `config.js` 一致。

每个角色需要：`walk / sit / dance / trip / forcethink / pet / drag / falling / fallen / climbSide / climbTop / hangstillSide / hangstillTop / jump`。

同步 AI 逻辑、语料与表情：

```bash
npm run sync-ai
npm run encrypt-assets
```

`sync-ai` 会覆盖 `persona.js`、`tts.js`、`persona-assets.js`、`stickers.js` 和表情素材，不会覆盖桌面专用的实时语音模块。若上游改变 `/api/chat` 合同，需要同步更新 `src-tauri/src/api.rs` 和 `src/chat.js`。

新增角色的完整步骤见 [创建角色指南](docs/creating-a-pet.md)。

## 发布

1. 同步修改 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `Cargo.lock` 的版本号。
2. 提交 `chore(release): vX.Y.Z`，先推 commit，再推 `vX.Y.Z` tag。
3. 推送 tag 后 GitHub Actions 校验版本，并同时构建 Windows x64、macOS ARM64 和 macOS Intel 安装包。
4. Changelog 根据 Conventional Commits 自动生成，完整历史见 [GitHub Releases](https://github.com/aaronfang/kxyy-desktop-pet/releases)。

CI 与发布职责：

| 触发 | 工作流 | 结果 |
|---|---|---|
| push / PR → `main` | [CI](.github/workflows/ci.yml) | Windows x64 + macOS ARM64 检查，不发布 |
| push `v*` tag | [Release](.github/workflows/release.yml) | 校验六处版本号，构建 Windows x64 与 macOS ARM64 / Intel 并上传 Release |
| 手动 Release + `include_macos` | [Release](.github/workflows/release.yml) | 修复既有 Release：勾选时仅追加 macOS 双架构，否则仅重建 Windows |

## 项目文档

| 文档 | 用途 |
|---|---|
| [AI 角色体验路线图](docs/roadmap-ai-roleplay.md) | 当前完成度、角色体验和优先级 |
| [实时语音路线图](docs/roadmap-realtime-voice.md) | 打断、ASR/TTS、流式能力和验证边界 |
| [Memory Brain 路线图](docs/roadmap-memory-brain.md) | Memory v3/v3.1、关系图和外部接入计划 |
| [Memory M0 验收清单](docs/qa-memory-v3-m0.md) | Memory 的人工验收入口 |

## 致谢

动画引擎源自 Lars de Rooij 的 [webmeji](https://webmeji.neocities.org)。
