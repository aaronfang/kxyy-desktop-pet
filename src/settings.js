// 设置页：读取 / 写回 AI 与聊天配置（持久化在 settings.json）。
import { DEFAULT_AI_AVATAR, DEFAULT_USER_AVATAR } from "./ai/avatars.js";

const invoke = window.__TAURI__.core.invoke;

// 头像不进 FIELDS：走上传按钮维护，值缓存在下面两个变量里。
const FIELDS = [
  "deepseekKey",
  "qwenVlKey",
  "volcTtsKey",
  "ttsVoice",
  "realtimeAppId",
  "realtimeAccessKey",
  "realtimeVoice",
  "textModel",
  "temperature",
  "userName",
  "patText",
  "personaRelationship",
  "personaFacts",
  "personaJokes",
  "personaTreatAs",
  "chatFontSize",
  "hotkey",
  "chatWidth",
  "chatHeight",
  "chatBottomOffset",
];

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const saveBtn = el("save");

// 头像 data URL 缓存（空串表示用默认；保存时也存空串，前端渲染时兜底默认）。
let aiAvatar = "";
let userAvatar = "";

function renderAvatars() {
  el("aiAvatarPreview").src = aiAvatar || DEFAULT_AI_AVATAR;
  el("userAvatarPreview").src = userAvatar || DEFAULT_USER_AVATAR;
}

function fill(s) {
  s = s || {};
  el("deepseekKey").value = s.deepseekKey || "";
  el("qwenVlKey").value = s.qwenVlKey || "";
  el("volcTtsKey").value = s.volcTtsKey || "";
  el("ttsVoice").value = s.ttsVoice || "";
  el("realtimeAppId").value = s.realtimeAppId || "";
  el("realtimeAccessKey").value = s.realtimeAccessKey || "";
  el("realtimeVoice").value = s.realtimeVoice || "";
  el("autoSpeak").checked = !!s.autoSpeak;
  el("textModel").value = s.textModel || "";
  el("thinking").checked = !!s.thinking;
  el("temperature").value = s.temperature ?? 0.8;
  el("userName").value = s.userName || "";
  el("patText").value = s.patText || "";
  el("personaRelationship").value = s.personaRelationship || "";
  el("personaFacts").value = s.personaFacts || "";
  el("personaJokes").value = s.personaJokes || "";
  el("personaTreatAs").value = s.personaTreatAs || "";
  el("loadPersona").checked = s.loadPersona !== false;
  aiAvatar = s.aiAvatar || "";
  userAvatar = s.userAvatar || "";
  el("chatFontSize").value = s.chatFontSize ?? 14;
  el("hotkey").value = s.hotkey || "Ctrl+Shift+Space";
  el("chatWidth").value = s.chatWidth ?? 420;
  el("chatHeight").value = s.chatHeight ?? 340;
  el("chatBottomOffset").value = s.chatBottomOffset ?? 96;
  renderAvatars();
}

async function load() {
  try {
    fill(await invoke("get_settings"));
  } catch (e) {
    console.error(e);
  }
}

function collect() {
  return {
    deepseekKey: el("deepseekKey").value.trim(),
    qwenVlKey: el("qwenVlKey").value.trim(),
    volcTtsKey: el("volcTtsKey").value.trim(),
    ttsVoice: el("ttsVoice").value.trim(),
    realtimeAppId: el("realtimeAppId").value.trim(),
    realtimeAccessKey: el("realtimeAccessKey").value.trim(),
    realtimeVoice: el("realtimeVoice").value.trim(),
    autoSpeak: el("autoSpeak").checked,
    textModel: el("textModel").value,
    thinking: el("thinking").checked,
    temperature: Number(el("temperature").value) || 0.8,
    userName: el("userName").value.trim(),
    patText: el("patText").value.trim(),
    personaRelationship: el("personaRelationship").value.trim(),
    personaFacts: el("personaFacts").value.trim(),
    personaJokes: el("personaJokes").value.trim(),
    personaTreatAs: el("personaTreatAs").value.trim(),
    loadPersona: el("loadPersona").checked,
    aiAvatar,
    userAvatar,
    chatFontSize: parseInt(el("chatFontSize").value, 10) || 14,
    hotkey: el("hotkey").value.trim() || "Ctrl+Shift+Space",
    chatWidth: parseInt(el("chatWidth").value, 10) || 420,
    chatHeight: parseInt(el("chatHeight").value, 10) || 340,
    chatBottomOffset: parseInt(el("chatBottomOffset").value, 10) || 96,
  };
}

async function save() {
  saveBtn.disabled = true;
  statusEl.textContent = "";
  try {
    await invoke("set_ai_settings", { settings: collect() });
    statusEl.style.color = "#16a34a";
    statusEl.textContent = "已保存";
  } catch (e) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = `保存失败：${e.message || e}`;
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => (statusEl.textContent = ""), 2500);
  }
}

// ---- 头像上传：读成 dataURL 缓存（保存时随 settings 一起落盘）----
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function bindAvatar(kind) {
  const cap = kind === "ai" ? "ai" : "user";
  const fileEl = el(`${cap}AvatarFile`);
  el(`${cap}AvatarUpload`).addEventListener("click", () => fileEl.click());
  el(`${cap}AvatarReset`).addEventListener("click", () => {
    if (kind === "ai") aiAvatar = "";
    else userAvatar = "";
    renderAvatars();
  });
  fileEl.addEventListener("change", async () => {
    const file = fileEl.files?.[0];
    fileEl.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (kind === "ai") aiAvatar = dataUrl;
      else userAvatar = dataUrl;
      renderAvatars();
    } catch (_) {}
  });
}

bindAvatar("ai");
bindAvatar("user");

// ---- API Key 显示 / 隐藏开关 ----
document.querySelectorAll(".pw-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = el(btn.dataset.target);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.classList.toggle("on", show);
    btn.setAttribute("aria-label", show ? "隐藏" : "显示");
  });
});

saveBtn.addEventListener("click", save);
FIELDS.forEach((id) => {
  const node = el(id);
  if (node) node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && node.tagName !== "TEXTAREA") save();
  });
});

load();
