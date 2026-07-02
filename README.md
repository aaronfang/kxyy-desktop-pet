# 元元桌宠 (kxyy-desktop-pet)

基于 [webmeji](https://github.com/lars-rooij/webmeji) 动画逻辑改造的 **macOS / Windows 跨平台桌面宠物**，用 **[Tauri](https://tauri.app) 2** 封装（前端 Web 动画 + Rust 主进程）。桌宠会在屏幕上走动、坐下、跳舞、攀爬屏幕边缘，可拖拽、可抚摸，右键或托盘可切换形象。

当前内置两套形象：**赛博元元**（`kxyy-cyber`）与 **苗疆元元**（`kxyy-miaojiang`）。

> 相比早期 Electron 版本：安装包由 ~70MB 降至 **~4MB**，内存占用大幅下降（Tauri 复用系统 WebView，无独立 Chromium）。

## 环境要求

- [Node.js](https://nodejs.org)（用于 Tauri CLI）
- [Rust](https://www.rust-lang.org/tools/install)（`rustc` / `cargo`）
- 平台依赖：
  - **Windows**：WebView2 运行时（Win10/11 一般自带）+ MSVC 生成工具
  - **macOS**：Xcode Command Line Tools

## 运行

```bash
npm install
npm run dev        # 开发模式（tauri dev）
```

启动后桌宠出现在屏幕底部，菜单栏 / 托盘会出现一个图标：

- **显示 / 隐藏桌宠**
- **选择形象**：赛博元元 / 苗疆元元
- **大小**：100% / 125% / 150% / 200%
- **开机自启**
- **退出**

也可以直接**右键点击桌宠**弹出同样的菜单。桌宠之外的区域鼠标可正常穿透，不影响操作其它软件。

## 交互

- **拖拽**：按住桌宠拖动，松手后它会掉落到屏幕底部。
- **抚摸**：鼠标悬停在桌宠上会触发抚摸动画。
- **自动行为**：走路、坐、旋转、跳舞、思考，以及跳到屏幕左/右/上边缘攀爬、悬挂、坠落。

> 点击穿透说明：Tauri 没有 Electron 的「鼠标事件转发」，故穿透态下由前端低频轮询光标坐标做像素级命中判定，仅当指针接近桌宠时才切回可交互态，桌宠外的透明区域始终穿透。

## 打包

```bash
npm run build       # 当前平台
npm run build:win   # Windows 安装包 (NSIS)
npm run build:mac   # macOS dmg
```

产物在 `src-tauri/target/release/bundle/` 目录。

> 图标：`src-tauri/icons/` 由 `npx tauri icon <方形png>` 生成；仓库 `build/icon-square.png` 为图标源。

## 目录结构

```
src/                  前端（渲染层，随前端一起打包）
  index.html
  styles.css
  pet-config.js       角色配置与注册
  pet-engine.js       动画引擎（源自 webmeji 的 Creature）
  app.js              启动、点击穿透命中判定、右键菜单联动（Tauri IPC）
  assets/pets/        两套角色素材：<角色id>/<动作>/<动作>_NN.png
src-tauri/            Rust 主进程
  src/lib.rs          透明置顶穿透窗口、托盘菜单、开机自启、设置持久化、IPC 命令
  src/main.rs         入口
  tauri.conf.json     窗口 / 打包 / 图标配置
  capabilities/       前端权限
  icons/              应用图标
shared/
  roster.json         角色清单（主进程托盘与前端共用，编译期嵌入 Rust）
scripts/
  sync-assets.mjs     从 web 工程同步素材到 src/assets/pets
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

## 致谢

动画引擎源自 Lars de Rooij 的 [webmeji](https://webmeji.neocities.org)。
