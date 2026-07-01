const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const ROSTER = require("../shared/roster.json");
const SIZE_PRESETS = [
  { label: "小 (100%)", value: 100 },
  { label: "中 (125%)", value: 125 },
  { label: "大 (150%)", value: 150 },
  { label: "超大 (200%)", value: 200 },
];

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  const defaults = { petId: ROSTER.defaultPetId, sizePercent: 150, hidden: false };
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const saved = JSON.parse(raw);
    return { ...defaults, ...saved };
  } catch (_) {
    return defaults;
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.warn("保存设置失败:", e);
  }
}

let settings = null;
let win = null;
let tray = null;

function trayIcon() {
  // 用当前角色的一帧作为托盘图标
  const framePath = path.join(
    __dirname, "..", "assets", "pets", settings.petId, "sit", "sit_01.png",
  );
  let img = nativeImage.createFromPath(framePath);
  if (img.isEmpty()) {
    const fallback = path.join(__dirname, "..", "assets", "pets", ROSTER.defaultPetId, "sit", "sit_01.png");
    img = nativeImage.createFromPath(fallback);
  }
  return img.isEmpty() ? img : img.resize({ width: 18, height: 18 });
}

function primaryWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

function createWindow() {
  const area = primaryWorkArea();
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.showInactive());
}

function fitToWorkArea() {
  if (!win) return;
  const area = primaryWorkArea();
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

function pushSettings(patch) {
  win?.webContents.send("pet:apply-settings", patch);
}

function setPet(petId) {
  if (petId === settings.petId) return;
  settings.petId = petId;
  saveSettings();
  pushSettings({ petId });
  tray?.setImage(trayIcon());
  rebuildTray();
}

function setSize(sizePercent) {
  settings.sizePercent = sizePercent;
  saveSettings();
  pushSettings({ sizePercent });
  rebuildTray();
}

function setHidden(hidden) {
  settings.hidden = hidden;
  saveSettings();
  pushSettings({ hidden });
  rebuildTray();
}

function toggleLogin() {
  const opened = app.getLoginItemSettings().openAtLogin;
  app.setLoginItemSettings({ openAtLogin: !opened });
  rebuildTray();
}

function buildMenuTemplate() {
  return [
    {
      label: settings.hidden ? "显示桌宠" : "隐藏桌宠",
      click: () => setHidden(!settings.hidden),
    },
    { type: "separator" },
    {
      label: "选择形象",
      submenu: ROSTER.pets.map((p) => ({
        label: p.label,
        type: "radio",
        checked: p.id === settings.petId,
        click: () => setPet(p.id),
      })),
    },
    {
      label: "大小",
      submenu: SIZE_PRESETS.map((s) => ({
        label: s.label,
        type: "radio",
        checked: s.value === settings.sizePercent,
        click: () => setSize(s.value),
      })),
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: () => toggleLogin(),
    },
    { type: "separator" },
    { label: "退出", role: "quit" },
  ];
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("元元桌宠");
  rebuildTray();
  tray.on("click", () => tray.popUpContextMenu());
}

// ---- IPC ----
ipcMain.handle("pet:get-settings", () => ({
  petId: settings.petId,
  sizePercent: settings.sizePercent,
  hidden: settings.hidden,
}));

ipcMain.on("pet:set-ignore-mouse", (_e, ignore) => {
  win?.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on("pet:show-context-menu", () => {
  if (!win) return;
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
});

// ---- app lifecycle ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) win.showInactive();
  });

  app.whenReady().then(() => {
    settings = loadSettings();
    if (process.platform === "darwin") app.dock?.hide();
    createWindow();
    createTray();

    screen.on("display-metrics-changed", fitToWorkArea);
    screen.on("display-added", fitToWorkArea);
    screen.on("display-removed", fitToWorkArea);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 桌宠常驻，不随窗口关闭而退出（仅托盘退出）
  app.on("window-all-closed", (e) => {
    e.preventDefault?.();
  });
}
