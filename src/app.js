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

// ---- 聊天 → 桌宠：情绪驱动动作（映射沿用 kxyy_ai_clone/pet-bridge.js）----
const EMOTION_ACTION = {
  开心: "dance", 开心吃东西: "dance", 得意: "dance", 点赞: "dance", 期待: "dance",
  心动: "pet", 亲吻: "pet", 害羞: "pet", 尴尬: "pet", 卖萌: "pet", 眨眼: "pet",
  调皮: "spin", 惊讶: "spin",
  生气: "trip", 害怕: "trip",
  委屈: "sit", 哭: "sit",
  疑惑: "forcethink", 无语: "forcethink", 无语质问: "forcethink", 嫌弃: "forcethink", 暂停: "forcethink",
};
const DEFAULT_REPLY_ACTION = "dance";

function normEmotion(s) {
  return (s || "").replace(/[\s，。!！?？、,.]/g, "");
}

function mapEmotionToAction(emotion) {
  const raw = (emotion || "").trim();
  if (!raw) return null;
  if (EMOTION_ACTION[raw]) return EMOTION_ACTION[raw];
  const n = normEmotion(raw);
  const key = Object.keys(EMOTION_ACTION).find((k) => normEmotion(k) === n);
  return key ? EMOTION_ACTION[key] : DEFAULT_REPLY_ACTION;
}

function petCreatures() {
  return window.webmejiCreatures || [];
}

/** 处理 chat 窗口发来的 "pet-chat" 事件：思考 / 说话 / 回复(带情绪) / 用户消息 / 中断。 */
function handlePetChat(type, emotion) {
  if (hidden) return; // 桌宠隐藏时不驱动
  const list = petCreatures();
  if (!list.length) return;
  switch (type) {
    case "thinking":
      list.forEach((c) => c.startThinking?.());
      break;
    case "speaking":
      list.forEach((c) => c.startSpeaking?.());
      break;
    case "reply": {
      const emo = (emotion || "").trim();
      list.forEach((c) => {
        c.stopSpeaking?.();
        c.stopThinking?.();
        if (!emo) {
          c.resumeIdle?.();
          return;
        }
        const action = mapEmotionToAction(emo) || DEFAULT_REPLY_ACTION;
        const loops = action === "sit" ? 1 : 2;
        const durationMs = action === "forcethink" ? 2800 : action === "pet" ? 2000 : 2400;
        c.playReaction?.(action, { loops, durationMs });
      });
      break;
    }
    case "user":
      list.forEach((c) => {
        c.stopReactionModes?.();
        c.playReaction?.("pet", { loops: 1, durationMs: 1400 });
      });
      break;
    case "abort":
      list.forEach((c) => c.resumeIdle?.());
      break;
  }
}

function refreshPetBounds() {
  for (const c of window.webmejiCreatures || []) c.resizeHandler?.();
}

function applyPetSize(sizePercent) {
  const px = computePetSizePx(sizePercent);
  document.documentElement.style.setProperty("--pet-size", `${px}px`);
  refreshPetBounds();
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

  // 主窗口铺满工作区在 macOS 上异步完成，可能晚于桌宠初始化；
  // 若边界停在默认 800×600，角色会看起来只在左上角一块区域活动。
  refreshPetBounds();
  for (const ms of [50, 200, 500]) {
    setTimeout(refreshPetBounds, ms);
  }
  listen("stage-resized", () => refreshPetBounds());

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
    // 切换显示器时主窗口会重新铺满，补一次边界刷新。
    refreshPetBounds();
  });

  // 聊天窗口发来的对话状态：驱动桌宠思考 / 说话 / 按情绪做动作。
  listen("pet-chat", ({ payload }) => {
    const p = payload || {};
    handlePetChat(p.type, p.emotion);
  });

  console.log(`桌宠已启动: ${petId}`);
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => console.error("桌宠启动失败:", err));
});
