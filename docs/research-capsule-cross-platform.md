# 通话胶囊跨平台窗口可行性调研（2026-08-01）

## 结论

通话胶囊在 macOS 和 Windows 上都可以继续使用当前 Tauri 2 `chat` WebviewWindow 实现透明、无边框、置顶的小窗，并支持用户拖动。推荐调用 Tauri/TAO 的原生窗口拖动能力，而不是在前端监听 `pointermove` 后反复计算和设置窗口坐标。

已采用的方案是：只把胶囊波形区设为拖动热区，在主键 `mousedown` 中立即调用 Rust `start_chat_capsule_drag`；按钮区保持普通交互。拖动后由 Rust 监听窗口 `Moved` 事件，以去抖方式保存相对当前显示器工作区的位置。下次收起为胶囊时恢复保存位置并夹紧到可见区域。

这条路径跨平台可行，但有四个必须显式处理的边界：

1. `startDragging()` 必须紧跟鼠标按下调用；TAO 不保证脱离这次按下事件后仍能启动系统拖动。
2. TAO 明确说明 macOS 的原生拖动可能不再向 WebView 派发按钮释放事件，因此不能依赖 `mouseup` 做状态复位或位置持久化。
3. Tauri 的显示器工作区和窗口移动事件使用物理像素；跨 DPI/多屏恢复位置时不能直接持久化一组绝对 CSS 像素。
4. 窗口透明只影响绘制，不等于点击穿透。当前紧凑窗口高 64 px、可见胶囊高 48 px，四周为阴影保留的透明边缘仍会命中窗口。

## 当前仓库实现

- `src-tauri/tauri.conf.json` 中的 `chat` 窗口已设为 `transparent: true`、`decorations: false`、`alwaysOnTop: true`、`resizable: false`、`skipTaskbar: true`、`shadow: false`，具备胶囊小窗所需的基础属性。
- `src-tauri/src/lib.rs::position_chat_capsule` 将同一个 `chat` 窗口改为 252 x 64 逻辑像素；首次使用放到当前显示器工作区右下角并保留 24 px 边距，之后恢复已保存位置。Windows 使用物理像素，macOS/Linux 经 `work_area_logical` 转换。
- `set_chat_compact_window` 在普通聊天窗和胶囊之间改尺寸、定位并发送 `chat-window-mode`。Rust 通过 `WindowEvent::Moved` 做 360 ms 去抖，把显示器名称、相对工作区左上角的逻辑坐标和左右贴边状态写入设置。
- `src/chat.html` / `src/chat.css` 中可见胶囊为 240 x 48 px，位于 252 x 64 px 原生窗口内；展开和挂断按钮位于胶囊内部。贴近左右边缘 20 px 时会吸附，离开后 900 ms 自动收窄到 `capsuleCollapsedWidth`（64--160 px，默认 96 px）。
- 拖动通过只接受 `chat` 窗口调用的 Rust command 完成，因此不需要向前端 capability 开放 `start_dragging` 或 `set_position`。
- 锁定版本为 Tauri 2.11.5、`tauri-runtime-wry` 2.11.4、WRY 0.55.1、TAO 0.35.3。下面的源码判断以这些版本为准。

## 官方 API 与行为

### 原生窗口拖动

Tauri JavaScript `Window.startDragging()` 通过 `plugin:window|start_dragging` 调到原生窗口层。[Tauri 2.11.5 JavaScript API 源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts#L1678-L1692)；Rust 的 `WebviewWindow::start_dragging()` 也直接转交窗口实现。[Tauri 2.11.5 Rust 源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/webview/webview_window.rs#L2137-L2140)

Tauri 官方的无边框标题栏指南给出两种入口：给元素加 `data-tauri-drag-region`，或在 `mousedown` 且主键按下时手动调用 `startDragging()`。属性只对直接带属性的元素生效，不会自动覆盖子元素；官方还指出 Windows 可用 CSS `app-region: drag` 获得触控笔/触摸拖动。[Tauri 官方窗口定制指南](https://v2.tauri.app/learn/window-customization/#creating-a-custom-titlebar)；[手动拖动示例](https://v2.tauri.app/learn/window-customization/#manual-implementation-of-data-tauri-drag-region)

底层 TAO 的约束更具体：`drag_window()` 只有在左键刚刚按下后调用才有工作保证；macOS 上它可能阻止按钮释放事件回传。[TAO 0.35.3 `Window::drag_window`](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/window.rs#L1295-L1306)

两个桌面平台最终都交给系统窗口管理器，但实现不同：

| 平台 | TAO 0.35.3 实现 | 对本项目的含义 |
| --- | --- | --- |
| Windows | 释放当前鼠标捕获后发送 `WM_NCLBUTTONDOWN`，命中值为 `HTCAPTION`，让系统按标题栏拖动窗口。[TAO Windows 源码](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/platform_impl/windows/window.rs#L529-L558) | 原生拖动可正确处理系统移动循环、吸附和跨屏；应在 `mousedown` 同步触发。 |
| macOS | 调用 AppKit `NSWindow.performWindowDragWithEvent`；必要时从当前事件构造左键按下事件。[TAO macOS 源码](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/platform_impl/macos/window.rs#L928-L958) | 不要等待 `mouseup` 才提交位置或清理关键状态；依赖 `Moved` 事件和去抖收敛。 |

### 位置、工作区与 DPI

Tauri `outerPosition()` 返回窗口左上角相对整个桌面的物理坐标；`setPosition()` 接受明确的 `LogicalPosition` 或 `PhysicalPosition`。[读取位置源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts#L573-L587)；[设置位置源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts#L1412-L1429)

官方 `Monitor` 接口将显示器 `position`、`size` 和排除任务栏/Dock 后的 `workArea` 都定义为物理像素，并要求使用 `scaleFactor` 转成逻辑像素。窗口 `onMoved` 的 payload 同样是 `PhysicalPosition`。[Tauri 2.11.5 Monitor 定义](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts#L44-L90)；[`onMoved` 定义](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/packages/api/src/window.ts#L1875-L1893)

本仓库已经因 TAO 0.35.3 在 macOS/Windows 的工作区换算差异做了 Rust 平台分流。胶囊拖动和恢复应继续留在 Rust 这一侧，复用 `resolve_monitor`、`work_area_logical` 以及现有实测约束，不要在 `chat.js` 再建立一套坐标模型。

### 透明、无边框、阴影与分发限制

Tauri 的窗口配置原生支持 `transparent`、`decorations`、`alwaysOnTop` 和 `shadow`。macOS 透明窗口要求开启 `app.macOSPrivateApi` / Cargo `macos-private-api`；官方明确警告使用该私有 API 会导致应用不能被 Mac App Store 接受。[Tauri 2.11.5 WindowConfig 源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/config.rs#L2020-L2040)；[`macOSPrivateApi` 源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/config.rs#L3065-L3100)

当前项目已经同时在配置和 Cargo feature 中启用该能力，并通过 DMG 分发，因此技术上无新增阻碍；产品约束是继续不能把 Mac App Store 当作这套透明窗口构建的发布渠道。

Windows 上，Tauri 2.11.5 说明无边框窗口开启 `shadow: true` 会产生 1 px 白边，并在 Windows 11 获得系统圆角。当前胶囊配置为 `shadow: false`，适合由 CSS 自绘阴影和圆角。[Tauri 2.11.5 阴影平台说明](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/config.rs#L2087-L2102)

`skipTaskbar` 在该版本官方配置中明确只隐藏 Windows/Linux 任务栏图标；它不是 macOS 隐藏 Dock 的机制。[Tauri 2.11.5 `skip_taskbar`](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/config.rs#L2041-L2055) 本项目的 macOS 无 Dock 图标仍依赖 `LSUIElement=true` 和 `ActivationPolicy::Accessory`，不能删掉这两层。

`visibleOnAllWorkspaces` 在 Windows 不受支持，因此“置顶”不等于“跨所有虚拟桌面可见”。[Tauri 2.11.5 平台说明](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/config.rs#L2041-L2047) 跨平台产品语义应定义为“当前虚拟桌面内置顶”，不要承诺 Windows 虚拟桌面间常驻。

透明区域仍属于原生窗口的命中区域。TAO 把点击穿透作为独立的 `set_ignore_cursor_events` 能力，并说明开启后事件才会传给后方窗口。[TAO 0.35.3 cursor event 文档](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/window.rs#L1322-L1332) 因此不能把 CSS `background: transparent` 当作逐像素穿透。

## 实现状态与余项

### P0：增加原生拖动热区

已在 `#call-capsule-wave` 上监听 `mousedown`，仅在主键按下时立即调用 Rust command。没有 `await` 后启动、没有用 `pointermove` 模拟窗口移动，也没有把整个 `#chat` 设为拖动区。

调研确认过两种等价接入方式：

- **推荐的最小权限方式**：新增只接受 `chat` 调用窗口的 Rust command，内部调用 `window.start_dragging()`；前端继续沿用当前 `invoke` 模式。命令应校验 `window.label() == "chat"`。
- **Tauri 标准前端方式**：调用 `window.__TAURI__.window.getCurrentWindow().startDragging()`，并新增仅匹配 `chat` 窗口的 capability，权限为 `core:window:allow-start-dragging`。不要把该权限直接加给同时覆盖 `main/chat/settings` 的现有默认 capability。官方确认 `start_dragging` 不是 `core:window:default` 的默认权限。[Tauri 官方 capability 示例](https://v2.tauri.app/learn/window-customization/#permissions)；[Tauri 2.11.5 权限表](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/permissions/window/autogenerated/reference.md#corewindowallow-start-dragging)

不推荐只使用 CSS `app-region: drag`：官方只把它作为 Windows 触摸/触控笔增强方案，不能替代 macOS 的 Tauri 拖动入口。若后续确实要支持 Windows 触控，可以在 P0 原生方案上针对 Windows 增强。

### P1：保存相对工作区的位置

Rust 已为 `chat` 注册 `WindowEvent::Moved`。只有 `chat_compact == true` 且胶囊未收窄时记录，使用 360 ms 去抖写入设置，不依赖前端 `mouseup`。

当前保存“显示器标识 + 相对工作区左上角的逻辑坐标 + 左右贴边状态”，而不是桌面绝对物理坐标。恢复时：

1. 优先找保存的显示器；不存在时使用窗口当前屏，再回退主屏。
2. 按目标显示器当前 scale factor 计算物理位置。
3. 将整个 252 x 64 窗口夹紧到工作区，保留完整可拖动热区。
4. 只有无已保存位置时才使用当前右下角 24 px 默认值。

`set_chat_compact_window(false)` 展开聊天窗时仍可回到设置定义的底部居中位置；再次收起时恢复胶囊自己的位置。两种窗口模式的位置应分开保存，避免互相覆盖。

### P1：消除透明命中死区

当前 252 x 64 原生窗口内是 240 x 48 的常驻可见胶囊，透明命中边缘已从旧版的大块上方空白缩到四周 6--11 px，主要用于阴影。跨平台仍应让原生窗口几何尽量贴合可见/可交互内容：

- 展开、挂断按钮已经移入胶囊内部，窗口高度缩到 64 px；发布前仍需在两端确认阴影边缘没有形成明显点击死区。
- 不要频繁切换整窗 `set_ignore_cursor_events`，因为该 API 会让胶囊自身也无法收到用于恢复命中的鼠标事件。
- 不建议做平台原生逐像素 hit-test 作为首版，它需要分别进入 Win32 `WM_NCHITTEST` 和 AppKit hit testing，超出 Tauri 公共窗口 API 的简单跨平台路径。

## 验收矩阵

| 场景 | macOS | Windows |
| --- | --- | --- |
| 主键从波形区按下并拖动 | 窗口连续移动；即使无前端 `mouseup`，状态和位置也最终收敛 | 窗口进入系统移动循环；普通鼠标拖动正常 |
| 波形区点击、展开、挂断 | 点击不误触拖动；按钮不属于拖动热区 | 同左；另测 125%/150% DPI |
| 跨显示器拖动 | Retina/非 Retina 混合缩放后位置不跳变，重启仍在可见工作区 | 不同 DPI 显示器间拖动后，恢复位置和边距正确 |
| 工作区变化 | Dock 位置/自动隐藏变化后夹紧可见 | 任务栏位置、自动隐藏和分辨率变化后夹紧可见 |
| 透明命中 | 胶囊外透明区域不应形成不可解释的大块点击死区 | 同左；检查 Windows 11 圆角/白边，保持 `shadow: false` |
| 窗口层级 | 当前 Space 内置顶；切换 Space 行为符合产品定义 | 当前虚拟桌面内置顶；不要求跨虚拟桌面出现 |
| 模式切换 | 普通窗位置与胶囊位置互不覆盖 | 同左 |

## 决策建议

P0 原生拖动、Rust 侧位置持久化和缩小透明命中矩形已经在同一个 `chat` WebviewWindow 内完成，无需第四个窗口或 AppKit/Win32 私有移动代码。当前恢复流程会按目标工作区夹紧，但胶囊静止时不会主动监听 Dock/任务栏工作区变化；混合 DPI 跨屏和工作区动态变化仍按验收矩阵做人工验证。只有在产品明确要求逐像素点击穿透或 Windows 跨虚拟桌面常驻时，才需要超出 Tauri 公共 API 的平台专用实现。
