# 元元桌宠 (kxyy-desktop-pet)

基于 [webmeji](https://github.com/lars-rooij/webmeji) 动画逻辑改造的 **macOS / Windows 跨平台桌面宠物**，用 Electron 封装。桌宠会在屏幕上走动、坐下、跳舞、攀爬屏幕边缘，可拖拽、可抚摸，右键或托盘可切换形象。

当前内置两套形象：**赛博元元**（`kxyy-cyber`）与 **苗疆元元**（`kxyy-miaojiang`）。

## 运行

```bash
npm install
npm start
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

## 打包

```bash
npm run dist:mac    # 生成 macOS dmg / zip
npm run dist:win    # 生成 Windows 安装包 / 便携版
npm run dist        # 当前平台
```

产物在 `release/` 目录。首次打包会自动下载对应平台的 Electron 运行时。

> 提示：可在 `build/` 放置 `icon.icns`（mac）与 `icon.ico`（win）作为应用图标；未提供时使用 Electron 默认图标。

## 目录结构

```
electron/        主进程（透明置顶窗口、点击穿透、托盘、IPC）
  main.js
  preload.js
renderer/        渲染进程（桌宠动画）
  index.html
  styles.css
  pet-config.js  角色配置与注册
  pet-engine.js  动画引擎（源自 webmeji 的 Creature）
  app.js         启动、像素级悬停判定、右键菜单联动
shared/
  roster.json    角色清单（主进程托盘与渲染进程共用）
assets/pets/     两套角色素材：<角色id>/<动作>/<动作>_NN.png
scripts/
  sync-assets.mjs 从 web 工程同步素材
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
   - 在 `renderer/pet-config.js` 用 `registerPet("新id", { frames: {...}, ... })` 配置帧数与节奏（帧数与上游 `config.js` 保持一致即可）。

每个角色需要的动作目录：`walk / sit / dance / trip / forcethink / pet / drag / falling / fallen / climbSide / climbTop / hangstillSide / hangstillTop / jump`。

## 致谢

动画引擎源自 Lars de Rooij 的 [webmeji](https://webmeji.neocities.org)。
