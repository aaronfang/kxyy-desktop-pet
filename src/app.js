// 桌面端启动（Tauri）：拉取设置 → 初始化桌宠 → 处理点击穿透与右键菜单。
// Tauri 无 Electron 的鼠标事件转发（forward），故穿透态用低频轮询光标坐标做像素级命中判定，
// 仅当指针接近桌宠时才切回可交互；桌宠之外的透明区域始终穿透，不影响操作其它软件。

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const PET_SIZE_BASE = 100; // 基准边长(px)，再乘设置里的百分比

let hidden = false;
let interactive = false; // 当前窗口是否处于可交互（非穿透）态
let pollTimer = null;

function computePetSizePx(sizePercent) {
  const pct = Number(sizePercent);
  const scale = (Number.isFinite(pct) ? pct : 100) / 100;
  return Math.round(PET_SIZE_BASE * Math.max(0.5, Math.min(3, scale)));
}

function applyPetSize(sizePercent) {
  const px = computePetSizePx(sizePercent);
  document.documentElement.style.setProperty("--pet-size", `${px}px`);
  for (const c of window.webmejiCreatures || []) c.resizeHandler?.();
}

/** 指针是否在桌宠外接矩形附近（含 margin），用于决定轮询频率 */
function nearPet(x, y, margin = 140) {
  const c = window.webmejiCreatures?.[0];
  if (!c || !c.container || c.container.hidden) return false;
  const r = c.container.getBoundingClientRect();
  return (
    x >= r.left - margin && x <= r.right + margin &&
    y >= r.top - margin && y <= r.bottom + margin
  );
}

/** 指针是否落在桌宠的不透明像素上（像素级判定，透明区域可穿透） */
function pointOverPet(x, y) {
  const c = window.webmejiCreatures?.[0];
  if (!c || !c.container || c.container.hidden) return false;
  const rect = c.container.getBoundingClientRect();
  if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
  if (c.isDragging) return true;

  const canvas = c.canvas;
  if (!canvas.width || !rect.width) return true;
  const dprX = canvas.width / rect.width;
  const dprY = canvas.height / rect.height;
  let px = Math.floor((x - rect.left) * dprX);
  let py = Math.floor((y - rect.top) * dprY);
  if ((canvas.style.transform || "").includes("-1")) px = canvas.width - 1 - px;
  px = Math.max(0, Math.min(canvas.width - 1, px));
  py = Math.max(0, Math.min(canvas.height - 1, py));
  try {
    return c.ctx.getImageData(px, py, 1, 1).data[3] > 12;
  } catch (_) {
    return true;
  }
}

async function setInteractive(next) {
  if (next === interactive) return;
  interactive = next;
  try {
    await invoke("set_ignore_cursor", { ignore: !next });
  } catch (_) {}
  if (next) stopPolling();
  else startPolling();
}

// 穿透态：webview 收不到鼠标事件，改为轮询全局光标坐标判断是否回到桌宠上。
// 自适应频率：指针远离桌宠时降频（250ms）省 CPU，靠近时提频（50ms）保证响应。
function startPolling() {
  if (pollTimer || hidden) return;
  const tick = async () => {
    pollTimer = null;
    if (hidden || interactive) return;
    let nextDelay = 250;
    try {
      const p = await invoke("cursor_pos");
      if (p) {
        if (pointOverPet(p[0], p[1])) {
          setInteractive(true);
          return;
        }
        nextDelay = nearPet(p[0], p[1]) ? 50 : 250;
      }
    } catch (_) {}
    if (!hidden && !interactive) pollTimer = setTimeout(tick, nextDelay);
  };
  pollTimer = setTimeout(tick, 50);
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function applyHidden(h) {
  for (const c of window.webmejiCreatures || []) {
    if (!c.container) continue;
    c.container.style.display = h ? "none" : "";
    c.container.hidden = !!h;
    if (h) {
      c.stopReactionModes?.();
      c.pause?.(); // 隐藏时停掉动画循环，避免空跑占用 CPU
    } else {
      c.resume?.();
    }
  }
  if (h) stopPolling();
  else if (!interactive) startPolling();
}

function bindMouseTracking() {
  // 可交互态下用原生事件跟踪；移出桌宠不透明像素则切回穿透。
  window.addEventListener("mousemove", (e) => {
    if (!interactive) return;
    if (!pointOverPet(e.clientX, e.clientY)) setInteractive(false);
  });
  window.addEventListener("mouseup", (e) => {
    requestAnimationFrame(() => {
      if (interactive && !pointOverPet(e.clientX, e.clientY)) setInteractive(false);
    });
  });
  // 右键桌宠弹出菜单
  window.addEventListener("contextmenu", (e) => {
    if (interactive && pointOverPet(e.clientX, e.clientY)) {
      e.preventDefault();
      invoke("show_menu").catch(() => {});
    }
  });
}

async function boot() {
  let settings = {};
  try {
    settings = (await invoke("get_settings")) || {};
  } catch (_) {}
  const petId = settings.petId || window.DEFAULT_PET_ID;

  applyPetSize(settings.sizePercent ?? 150);
  await window.initPet(petId);
  applyPetSize(settings.sizePercent ?? 150);

  hidden = !!settings.hidden;
  applyHidden(hidden);
  bindMouseTracking();

  // 初始进入穿透态并开始轮询
  try {
    await invoke("set_ignore_cursor", { ignore: true });
  } catch (_) {}
  interactive = false;
  if (!hidden) startPolling();

  // 主进程下发的设置变更（切换角色 / 调整大小 / 显隐）
  listen("apply-settings", async ({ payload }) => {
    const data = payload || {};
    if (data.petId && data.petId !== window.currentPetId) {
      await window.swapPet(data.petId);
    }
    if (data.sizePercent != null) applyPetSize(data.sizePercent);
    if (data.hidden != null) {
      hidden = !!data.hidden;
      applyHidden(hidden);
    }
  });

  console.log(`桌宠已启动: ${petId}`);
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => console.error("桌宠启动失败:", err));
});
