// 设置页：读取 / 写回 AI 与聊天配置（持久化在 settings.json）。
import { DEFAULT_AI_AVATAR, DEFAULT_USER_AVATAR } from "./ai/avatars.js";
import { clearAllMemory } from "./ai/persona.js";

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const emit = window.__TAURI__.event.emit;

// 头像不进 FIELDS：走上传按钮维护，值缓存在下面两个变量里。
const FIELDS = [
  "deepseekKey",
  "qwenVlKey",
  "volcTtsKey",
  "ttsVoice",
  "realtimeBackend",
  "realtimeAppId",
  "realtimeAccessKey",
  "cosyvoiceVoice",
  "cosyvoiceModel",
  "localRefWav",
  "localRefText",
  "voiceVolume",
  "textProvider",
  "textModel",
  "localTextModel",
  "localVlModel",
  "vlProvider",
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
/** @type {"macos"|"windows"|"linux"|string} */
let platform = "";

function renderAvatars() {
  el("aiAvatarPreview").src = aiAvatar || DEFAULT_AI_AVATAR;
  el("userAvatarPreview").src = userAvatar || DEFAULT_USER_AVATAR;
}

function normalizeBackend(v) {
  const x = (v || "").toLowerCase();
  if (x === "local") return "local";
  if (x === "cosyvoice" || x === "cosy") return "cosyvoice";
  return "volc";
}

function currentBackend() {
  return normalizeBackend(el("realtimeBackend").value);
}

/** 按所选语音后端只展示对应设置项。 */
function syncVoiceFields() {
  const backend = currentBackend();
  el("voiceFieldsVolc").hidden = backend !== "volc";
  el("voiceFieldsLocal").hidden = backend !== "local";
  el("voiceFieldsCosyvoice").hidden = backend !== "cosyvoice";
  // 参考音频仅对本地 Qwen3 可见。
  const refBox = el("voiceFieldsRef");
  if (refBox) {
    refBox.hidden = backend !== "local";
  }
}

function syncVoiceVolumeLabel() {
  const v = el("voiceVolume").value;
  el("voiceVolumeVal").textContent = `${v}%`;
}

/** 文字服务商：deepseek（在线）/ local（本地 Ollama）。 */
function currentTextProvider() {
  const v = (el("textProvider").value || "deepseek").toLowerCase();
  return v === "local" ? "local" : "deepseek";
}

/** 按所选文字服务商只展示对应设置项。 */
function syncTextFields() {
  const provider = currentTextProvider();
  el("textFieldsDeepseek").hidden = provider !== "deepseek";
  el("textFieldsLocal").hidden = provider !== "local";
  // 当切换到 local 时自动探测 Ollama 状态
  if (provider === "local") {
    void probeLocalTextStatus();
  }
}

/** 视觉模型服务商：qwen（在线）/ local（本地 Ollama VL）。 */
function currentVlProvider() {
  const v = (el("vlProvider").value || "qwen").toLowerCase();
  return v === "local" ? "local" : "qwen";
}

/** 按所选视觉服务商只展示对应设置项。 */
function syncVlFields() {
  const provider = currentVlProvider();
  el("vlFieldsQwen").hidden = provider !== "qwen";
  el("vlFieldsLocal").hidden = provider !== "local";
}

function fill(s) {
  s = s || {};
  el("deepseekKey").value = s.deepseekKey || "";
  el("qwenVlKey").value = s.qwenVlKey || "";
  el("volcTtsKey").value = s.volcTtsKey || "";
  // 朗读与通话共用音色；兼容旧版单独的 realtimeVoice。
  el("ttsVoice").value = s.ttsVoice || s.realtimeVoice || "";
  el("realtimeAppId").value = s.realtimeAppId || "";
  el("realtimeAccessKey").value = s.realtimeAccessKey || "";
  el("cosyvoiceVoice").value = s.cosyvoiceVoice || "";
  el("cosyvoiceModel").value = s.cosyvoiceModel || "";
  el("localRefWav").value = s.localRefWav || "";
  el("localRefText").value = s.localRefText || "";
  el("realtimeBackend").value = normalizeBackend(s.realtimeBackend);
  const vol = Number(s.voiceVolume);
  el("voiceVolume").value = Number.isFinite(vol)
    ? Math.max(0, Math.min(200, vol))
    : 100;
  syncVoiceVolumeLabel();
  syncVoiceFields();
  el("autoSpeak").checked = !!s.autoSpeak;
  el("showChatDebug").checked = s.showChatDebug === true;
  el("textProvider").value = s.textProvider === "local" ? "local" : "deepseek";
  el("textModel").value = s.textModel || "";
  el("localTextModel").value = s.localTextModel || "";
  el("localVlModel").value = s.localVlModel || "";
  el("vlProvider").value = s.vlProvider === "local" ? "local" : "qwen";
  syncTextFields();
  syncVlFields();
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
    realtimeBackend: currentBackend(),
    realtimeAppId: el("realtimeAppId").value.trim(),
    realtimeAccessKey: el("realtimeAccessKey").value.trim(),
    realtimeVoice: "",
    cosyvoiceVoice: el("cosyvoiceVoice").value.trim(),
    cosyvoiceModel: el("cosyvoiceModel").value.trim(),
    localRefWav: el("localRefWav").value.trim(),
    localRefText: el("localRefText").value.trim(),
    voiceVolume: Math.max(
      0,
      Math.min(200, parseInt(el("voiceVolume").value, 10) || 100),
    ),
    autoSpeak: el("autoSpeak").checked,
    showChatDebug: el("showChatDebug").checked,
    textProvider: currentTextProvider(),
    textModel: el("textModel").value,
    localTextModel: el("localTextModel").value.trim(),
    localVlModel: el("localVlModel").value.trim(),
    vlProvider: currentVlProvider(),
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

/** @type {string[]} */
const voiceSetupLogLines = [];

function backendLabel(backend) {
  if (backend === "local") return "Qwen3-TTS（本地）";
  if (backend === "cosyvoice") return "CosyVoice（通义云端）";
  if (backend === "volc") return "火山引擎（云端）";
  return backend || "本地服务";
}

function applyVoiceServiceStatus(payload) {
  const node = el("voiceServiceStatus");
  const logEl = el("voiceServiceLog");
  if (!node || !payload) return;
  const state = payload.state || "";
  const msg = (payload.message || "").trim();
  const backend = payload.backend || "";
  const label = backendLabel(backend);

  // 安装/启动过程：累积详细日志
  if (state === "starting" && msg) {
    const last = voiceSetupLogLines[voiceSetupLogLines.length - 1];
    if (msg !== last) {
      voiceSetupLogLines.push(msg);
      while (voiceSetupLogLines.length > 24) voiceSetupLogLines.shift();
    }
    if (logEl) {
      logEl.hidden = false;
      logEl.textContent = voiceSetupLogLines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    }
    // 标题行显示最新一步（STEP / 等待秒数优先）
    const headline =
      voiceSetupLogLines
        .slice()
        .reverse()
        .find((l) => /^STEP\b|仍在|下载|安装|完成|启动|配置/.test(l)) || msg;
    node.textContent = `${label}：${headline}`;
  } else if (state === "running") {
    node.textContent = msg ? `${label}：${msg}` : `${label}：已运行`;
    if (logEl && voiceSetupLogLines.length) {
      // 成功后保留日志片刻，便于确认
      setTimeout(() => {
        if (logEl && !logEl.hidden) {
          voiceSetupLogLines.length = 0;
          logEl.textContent = "";
          logEl.hidden = true;
        }
      }, 4000);
    }
  } else if (state === "ready") {
    node.textContent = msg ? `${label}：${msg}` : `${label}：就绪`;
  } else if (state === "warning") {
    node.textContent = msg ? `${label}：${msg}` : `${label}：请注意配置`;
  } else if (state === "failed") {
    node.textContent = msg ? `${label}：${msg}` : `${label}：失败`;
    if (logEl && voiceSetupLogLines.length) {
      logEl.hidden = false;
      logEl.textContent = voiceSetupLogLines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    }
  } else {
    node.textContent = msg ? `${label}：${msg}` : "本地服务：保存设置后自动启动";
    if (logEl && state !== "starting") {
      voiceSetupLogLines.length = 0;
      logEl.textContent = "";
      logEl.hidden = true;
    }
  }

  node.classList.remove(
    "state-running",
    "state-starting",
    "state-failed",
    "state-stopped",
    "state-skipped",
    "state-ready",
    "state-warning",
  );
  if (state) node.classList.add(`state-${state}`);
}

/** 探测当前选中后端的状态（不启动服务），立即更新状态提示。 */
async function probeBackendStatus() {
  const backend = currentBackend();
  try {
    const status = await invoke("probe_voice_backend", { backend });
    applyVoiceServiceStatus(status);
  } catch (e) {
    console.error("probe_voice_backend failed:", e);
    const node = el("voiceServiceStatus");
    if (node) {
      node.textContent = `${backendLabel(backend)}：无法探测状态`;
      node.className = "hint voice-service-status state-failed";
    }
  }
}

/** 更新本地文字模型（Ollama）状态提示。 */
function applyLocalTextStatus(payload) {
  const node = el("localTextServiceStatus");
  if (!node || !payload) return;
  const state = payload.state || "";
  const msg = (payload.message || "").trim();
  node.textContent = msg ? `Ollama：${msg}` : "Ollama：状态未知";
  node.classList.remove("state-running", "state-starting", "state-failed", "state-stopped");
  if (state) node.classList.add(`state-${state}`);
}

/** 探测本地文字模型（Ollama）状态（仅当前选中本地服务商时才有意义）。 */
async function probeLocalTextStatus() {
  if (currentTextProvider() !== "local") return;
  try {
    const status = await invoke("probe_local_text_backend");
    applyLocalTextStatus(status);
  } catch (e) {
    console.error("probe_local_text_backend failed:", e);
    const node = el("localTextServiceStatus");
    if (node) {
      node.textContent = "Ollama：无法探测状态";
      node.className = "hint voice-service-status state-failed";
    }
  }
}

/** 通用模型下载：调用 Rust pull_local_text_model，进度通过 local-text-pull-progress 事件推。 */
async function pullModel(modelFieldId, statusFieldId, btnId) {
  const btn = el(btnId);
  const statusEl = el(statusFieldId);
  const model = el(modelFieldId).value.trim() || (modelFieldId === "localVlModel" ? "minicpm-v:8b" : "qwen3:14b");
  btn.disabled = true;
  if (statusEl) {
    statusEl.style.color = "";
    statusEl.textContent = "准备下载…";
  }
  try {
    await invoke("pull_local_text_model", { model });
  } catch (e) {
    btn.disabled = false;
    if (statusEl) {
      statusEl.style.color = "#dc2626";
      statusEl.textContent = `下载失败：${e.message || e}`;
    }
  }
}

// 文字模型下载按钮
el("pullLocalModel")?.addEventListener("click", () =>
  pullModel("localTextModel", "localTextPullStatus", "pullLocalModel")
);

// 看图模型下载按钮
el("pullLocalVlModel")?.addEventListener("click", () =>
  pullModel("localVlModel", "localVlPullStatus", "pullLocalVlModel")
);

// 模型下载进度事件：根据 model 名称区分显示在哪个状态栏
listen("local-text-pull-progress", ({ payload }) => {
  if (!payload) return;
  const model = (payload.model || "").toLowerCase();
  // 判断是 VL 模型还是文字模型（VL 模型名通常包含 vision/vl/minicpm-v/llava 等）
  const isVl = /vision|vl\b|minicpm-v|llava|moondream|bakllava|llama.*vision/i.test(model);
  const statusEl = isVl ? el("localVlPullStatus") : el("localTextPullStatus");
  const btn = isVl ? el("pullLocalVlModel") : el("pullLocalModel");
  if (!statusEl) return;
  if (payload.error) {
    statusEl.style.color = "#dc2626";
    statusEl.textContent = `失败：${payload.error}`;
    if (btn) btn.disabled = false;
    return;
  }
  const pct = typeof payload.percent === "number" ? ` ${payload.percent.toFixed(0)}%` : "";
  statusEl.style.color = "";
  statusEl.textContent = `${payload.status || "下载中"}${pct}`;
  if (payload.done) {
    if (btn) btn.disabled = false;
    statusEl.style.color = "#16a34a";
    void probeLocalTextStatus();
  }
});

saveBtn.addEventListener("click", save);
el("realtimeBackend").addEventListener("change", () => {
  syncVoiceFields();
  probeBackendStatus();
});
el("textProvider").addEventListener("change", () => {
  syncTextFields();
  probeLocalTextStatus();
});
el("vlProvider").addEventListener("change", syncVlFields);
el("voiceVolume").addEventListener("input", syncVoiceVolumeLabel);

// ---- 参考音频「浏览…」：调用系统文件对话框，取本地绝对路径写回输入框 ----
el("localRefWavBrowse")?.addEventListener("click", async () => {
  try {
    const dialog = window.__TAURI__?.dialog;
    if (!dialog?.open) return;
    const selected = await dialog.open({
      multiple: false,
      directory: false,
      title: "选择参考音频",
      filters: [
        { name: "音频", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "aac"] },
      ],
    });
    if (typeof selected === "string" && selected) {
      el("localRefWav").value = selected;
    }
  } catch (e) {
    console.error(e);
  }
});
FIELDS.forEach((id) => {
  const node = el(id);
  if (node) node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && node.tagName !== "TEXTAREA") save();
  });
});

listen("voice-service-status", ({ payload }) => applyVoiceServiceStatus(payload));
listen("local-text-status", ({ payload }) => applyLocalTextStatus(payload));

el("clearMemory").addEventListener("click", async () => {
  const ok = window.confirm(
    "确定清空所有长期记忆？\n\n元元将不再记得你们之前的偏好、约定与对话概要。此操作不可撤销。",
  );
  if (!ok) return;
  const btn = el("clearMemory");
  const st = el("clearMemoryStatus");
  btn.disabled = true;
  try {
    clearAllMemory();
    await emit("memory-cleared", {});
    st.style.color = "#16a34a";
    st.textContent = "已清空";
  } catch (e) {
    st.style.color = "#dc2626";
    st.textContent = `失败：${e.message || e}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      st.textContent = "";
      st.style.color = "";
    }, 2500);
  }
});

async function init() {
  try {
    platform = await invoke("get_platform");
  } catch (_) {
    platform = "";
  }
  await load();
  // 页面加载后立即探测当前后端的就绪状态
  probeBackendStatus();
  probeLocalTextStatus();
}

init();
