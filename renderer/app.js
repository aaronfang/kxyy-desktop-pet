// 桌面端启动：拉取设置 → 初始化桌宠 → 处理点击穿透与右键菜单。
// 窗口整体默认「鼠标穿透」，只有指针悬停在桌宠不透明像素上时才临时变为可交互，
// 这样桌宠之外的桌面/其它软件都能正常点击。

const PET_SIZE_BASE = 100; // 基准边长(px)，再乘设置里的百分比

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

let interactive = false;
function setInteractive(next) {
  if (next === interactive) return;
  interactive = next;
  // 可交互时关闭穿透；否则开启穿透并转发 move 事件以便继续检测悬停
  window.petAPI?.setIgnoreMouse(!next);
}

function bindMouseTracking() {
  window.addEventListener("mousemove", (e) => {
    setInteractive(pointOverPet(e.clientX, e.clientY));
  });
  // 拖拽结束后重新判定
  window.addEventListener("mouseup", (e) => {
    requestAnimationFrame(() => setInteractive(pointOverPet(e.clientX, e.clientY)));
  });
  // 右键桌宠弹出菜单
  window.addEventListener("contextmenu", (e) => {
    if (pointOverPet(e.clientX, e.clientY)) {
      e.preventDefault();
      window.petAPI?.showContextMenu();
    }
  });
}

async function boot() {
  const settings = (await window.petAPI?.getSettings?.()) || {};
  const petId = settings.petId || window.DEFAULT_PET_ID;
  applyPetSize(settings.sizePercent ?? 150);
  await window.initPet(petId);
  applyPetSize(settings.sizePercent ?? 150);
  bindMouseTracking();
  console.log(`桌宠已启动: ${petId}`);

  // 主进程下发的设置变更（切换角色 / 调整大小 / 显隐）
  window.petAPI?.onApplySettings?.(async (data = {}) => {
    if (data.petId && data.petId !== window.currentPetId) {
      await window.swapPet(data.petId);
    }
    if (data.sizePercent != null) applyPetSize(data.sizePercent);
    if (data.hidden != null) {
      for (const c of window.webmejiCreatures || []) {
        if (!c.container) continue;
        c.container.style.display = data.hidden ? "none" : "";
        c.container.hidden = !!data.hidden;
        if (data.hidden) c.stopReactionModes?.();
      }
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => console.error("桌宠启动失败:", err));
});
