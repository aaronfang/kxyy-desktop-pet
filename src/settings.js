// 设置页：读取 / 写回 AI 与聊天配置（持久化在 settings.json）。
import { DEFAULT_AI_AVATAR, DEFAULT_AI_AVATAR_NEUTRAL, DEFAULT_USER_AVATAR } from "./ai/avatars.js";
import { clearAllMemory, loadCardProfile, saveCardProfile, saveCardVoice, loadCardVoice, saveCardAvatar, loadCardAvatar } from "./ai/persona.js";

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
  "personaCardId",
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
  const isCustomCard = Boolean(el("personaCardId").value.trim());
  el("aiAvatarPreview").src = aiAvatar || (isCustomCard ? DEFAULT_AI_AVATAR_NEUTRAL : DEFAULT_AI_AVATAR);
  el("userAvatarPreview").src = userAvatar || DEFAULT_USER_AVATAR;
}

function normalizeBackend(v) {
  const x = (v || "").toLowerCase();
  if (x === "local") return "local";
  if (x === "cosyvoice" || x === "cosy") return "cosyvoice";
  if (x === "volc") return "volc";
  return ""; // empty = off
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
  el("personaCardId").value = s.personaCardId || "";
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

// ---- persona card management ----

let _lastCardId = null;
let _cardList = [];

async function loadCardList() {
  try {
    _cardList = await invoke("list_all_cards");
  } catch (e) {
    console.error("list_all_cards failed:", e);
    _cardList = [];
  }
  const sel = el("personaCardId");
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  for (const card of _cardList) {
    if (card.id === "kxyy-yuanyuan") continue;
    const opt = document.createElement("option");
    opt.value = card.id;
    opt.textContent = "📦 " + card.name;
    opt.dataset.name = card.name;
    opt.dataset.desc = card.description || "";
    sel.appendChild(opt);
  }
  updateCardInfoDisplay();
}

async function onCardChanged() {
  const sel = el("personaCardId");
  const cardId = sel.value.trim();
  const opt = sel.selectedOptions?.[0];

  _lastCardId = cardId;
  updateCardInfoDisplay();
  if (cardId) {
    let cardAv = loadCardAvatar(cardId, "ai");
    if (!cardAv) {
      try { cardAv = await invoke("get_card_avatar", { cardId }); } catch (e) {}
    }
    aiAvatar = cardAv || "";
    userAvatar = loadCardAvatar(cardId, "user") || "";
  } else {
    aiAvatar = "";
    userAvatar = "";
  }
  renderAvatars();
  const profile = loadCardProfile(cardId) || {};
  el("userName").value = profile.userName || "";
  el("personaRelationship").value = profile.relationship || "";
  el("personaFacts").value = profile.facts || "";
  el("personaJokes").value = profile.jokes || "";
  el("personaTreatAs").value = profile.treatAs || "";
  const voice = loadCardVoice(cardId);
  if (voice) {
    el("realtimeBackend").value = normalizeBackend(voice.backend);
    el("ttsVoice").value = voice.voice || "";
    if (voice.backend === "volc") el("volcTtsKey").value = voice.key || "";
    else if (voice.backend === "cosyvoice") el("cosyvoiceModel").value = voice.model || "";
    else if (voice.backend === "local") { el("localRefWav").value = voice.refWav || ""; el("localRefText").value = voice.refText || ""; }
  }
  syncVoiceFields();
  probeBackendStatus();
  const label = opt?.dataset?.name || (cardId || "kxyy-yuanyuan");
  const titleEl = el("personaUserProfileTitle");
  if (titleEl) titleEl.textContent = "audience profile (" + label + ")";
  updateCardLabels(label);
}

function updateCardInfoDisplay() {
  const sel = el("personaCardId");
  const opt = sel?.selectedOptions?.[0];
  const infoDiv = el("personaCardInfo");
  if (!opt || !opt.value || !opt.dataset.name) {
    if (infoDiv) infoDiv.hidden = true;
    el("exportPersonaCardBtn").style.display = "none";
    el("deletePersonaCardBtn").style.display = "none";
    return;
  }
  if (infoDiv) infoDiv.hidden = false;
  el("personaCardName").textContent = opt.dataset.name;
  el("personaCardDesc").textContent = opt.dataset.desc || "";
  el("personaCardSource").textContent = "📦 local";
  el("exportPersonaCardBtn").style.display = "";
  el("deletePersonaCardBtn").style.display = "";
}

function updateCardLabels(label) {
  // placeholder
}

async function deleteCurrentCard() {
  const sel = el("personaCardId");
  const cardId = sel.value.trim();
  if (!cardId) return;
  const opt = sel.selectedOptions?.[0];
  const name = opt?.dataset?.name || cardId;
  if (!window.confirm("delete " + name + "?")) return;
  try {
    await invoke("delete_local_card", { cardId });
    await loadCardList();
    sel.value = _lastCardId || "";
    statusEl.textContent = "deleted " + name;
    statusEl.style.color = "#16a34a";
  } catch (e) {
    statusEl.textContent = "delete failed: " + e;
    statusEl.style.color = "#dc2626";
  } finally {
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  }
}

async function exportCurrentCard() {
  const cardId = el("personaCardId").value.trim();
  if (!cardId) return;
  try {
    const data = await invoke("export_card", { cardId });
    const { save } = window.__TAURI__?.dialog || {};
    const { writeTextFile } = window.__TAURI__?.fs || {};
    if (save && writeTextFile) {
      const path = await save({ defaultPath: cardId + ".persona-card.json", filters: [{ name: "persona card JSON", extensions: ["json"] }] });
      if (path) {
        await writeTextFile(path, JSON.stringify(data, null, 2));
        statusEl.textContent = "exported";
        statusEl.style.color = "#16a34a";
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
      }
    }
  } catch (e) {
    statusEl.textContent = "export failed: " + e;
    statusEl.style.color = "#dc2626";
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  }
}

async function importPersonaCard() {
  try {
    const { open } = window.__TAURI__?.dialog || {};
    const { readTextFile } = window.__TAURI__?.fs || {};
    let text;
    if (open && readTextFile) {
      const selected = await open({ multiple: false, filters: [{ name: "persona card JSON", extensions: ["json"] }] });
      if (!selected) return;
      text = await readTextFile(selected);
    } else {
      text = await new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = ".json";
        inp.onchange = async () => { const f = inp.files?.[0]; resolve(f ? await f.text() : null); };
        inp.click();
      });
      if (!text) return;
    }
    const card = JSON.parse(text);
    const cardId = await invoke("import_card_json", { json: JSON.stringify(card) });
    const name = card?.meta?.name || card?.identity?.name || cardId;
    await loadCardList();
    el("personaCardId").value = cardId;
    _lastCardId = cardId;
    statusEl.textContent = "imported " + name;
    statusEl.style.color = "#16a34a";
    onCardChanged();
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  } catch (e) {
    statusEl.textContent = "import failed: " + e;
    statusEl.style.color = "#dc2626";
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
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
    personaCardId: el("personaCardId").value.trim(),
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
  const cardId = el("personaCardId").value.trim();
  if (cardId) {
    saveCardProfile(cardId, { userName: el("userName").value.trim(), relationship: el("personaRelationship").value.trim(), facts: el("personaFacts").value.trim(), jokes: el("personaJokes").value.trim(), treatAs: el("personaTreatAs").value.trim() });
    const bk = currentBackend();
    if (bk) { saveCardVoice(cardId, { backend: bk, voice: el("ttsVoice").value.trim(), key: bk === "volc" ? el("volcTtsKey").value.trim() : undefined, model: bk === "cosyvoice" ? el("cosyvoiceModel").value.trim() : undefined, refWav: bk === "local" ? el("localRefWav").value.trim() : undefined, refText: bk === "local" ? el("localRefText").value.trim() : undefined }); }
  }
  saveBtn.disabled = true;
  statusEl.textContent = "";
  try {
    const payload = collect();
    await invoke("set_ai_settings", { settings: payload });
    // 通知聊天窗口热更新（人设卡 / 昵称 / 画像 / 头像 / 字号等）
    emit("apply-settings", payload);
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
      const cid = el("personaCardId").value.trim();
      if (cid) { saveCardAvatar(cid, kind, dataUrl); }
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

el("personaCardId")?.addEventListener("change", onCardChanged);
el("deletePersonaCardBtn")?.addEventListener("click", deleteCurrentCard);
el("exportPersonaCardBtn")?.addEventListener("click", exportCurrentCard);
el("importPersonaCardBtn")?.addEventListener("click", importPersonaCard);
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
    "确定清空当前人设卡的长期记忆？\n\n此操作只清当前人设卡下的记忆，不影响其他人设卡的记忆。此操作不可撤销。",
  );
  if (!ok) return;
  const btn = el("clearMemory");
  const st = el("clearMemoryStatus");
  btn.disabled = true;
  try {
    clearAllMemory(el("personaCardId").value.trim());
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
  // 必须先加载下拉列表选项，再 fill 表单，否则 fill 设置 personaCardId 时
  // 目标 option 尚未插入 select，value 赋值会被浏览器静默清空，导致重启后
  // 人设卡回退到默认 kxyy-yuanyuan。
  await loadCardList();
  await load();
  _lastCardId = el("personaCardId").value.trim();
  updateCardInfoDisplay();
  if (_lastCardId) {
    let cardAv = loadCardAvatar(_lastCardId, "ai");
    if (!cardAv) { try { cardAv = await invoke("get_card_avatar", { cardId: _lastCardId }); } catch (e) {} }
    if (cardAv) aiAvatar = cardAv;
  }
  userAvatar = loadCardAvatar(_lastCardId || "", "user") || "";
  renderAvatars();
  const opt = el("personaCardId").selectedOptions?.[0];
  const label = opt?.dataset?.name || (_lastCardId || "kxyy-yuanyuan");
  const titleEl = el("personaUserProfileTitle");
  if (titleEl) titleEl.textContent = "audience profile (" + label + ")";
  updateCardLabels(label);
  probeBackendStatus();
  probeLocalTextStatus();
}

init();
