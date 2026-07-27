// 设置页：读取 / 写回 AI 与聊天配置（持久化在 settings.json）。
import { DEFAULT_AI_AVATAR, DEFAULT_AI_AVATAR_NEUTRAL, DEFAULT_USER_AVATAR } from "./ai/avatars.js";
import { clearAllMemory, loadAllMemory, loadCardProfile, saveCardProfile, saveCardVoice, loadCardVoice, saveCardAvatar, loadCardAvatar, isKxyyPersona } from "./ai/persona.js";
import { memoryHealthState } from "./memory-ui.js";

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
  "asrProvider",
  "turnPauseTolerance",
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

function currentAsrProvider() {
  return (el("asrProvider")?.value || "whisper").toLowerCase() === "sensevoice"
    ? "sensevoice"
    : "whisper";
}

function currentTurnPauseTolerance() {
  const value = (el("turnPauseTolerance")?.value || "standard").toLowerCase();
  return value === "fast" || value === "long" ? value : "standard";
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
  const vadBox = el("vadShadowFields");
  if (vadBox) {
    vadBox.hidden = backend !== "local" && backend !== "cosyvoice";
  }
  const asrBox = el("asrFields");
  if (asrBox) {
    asrBox.hidden = backend !== "local" && backend !== "cosyvoice";
  }
  const pauseBox = el("turnPauseFields");
  if (pauseBox) {
    pauseBox.hidden = backend !== "local" && backend !== "cosyvoice";
  }
  const installSenseVoice = el("installSenseVoiceRuntime");
  if (installSenseVoice) {
    installSenseVoice.disabled = currentAsrProvider() !== "sensevoice";
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
  const privacy = el("memoryPrivacy");
  if (privacy) {
    privacy.textContent = provider === "local"
      ? "当前选择本地巩固：允许记忆的会话片段和归纳结果都由 Ollama 在本机处理。敏感内容和“别记这段”会在入队前过滤。"
      : "当前选择在线巩固：允许记忆的会话片段会直发 DeepSeek 进行后台整理；记忆数据库和归纳结果仍只保存在本机。敏感内容和“别记这段”会在发送前过滤。";
  }
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
  el("asrProvider").value = s.asrProvider === "sensevoice" ? "sensevoice" : "whisper";
  el("turnPauseTolerance").value =
    s.turnPauseTolerance === "fast" || s.turnPauseTolerance === "long"
      ? s.turnPauseTolerance
      : "standard";
  el("realtimeBackend").value = normalizeBackend(s.realtimeBackend);
  const vol = Number(s.voiceVolume);
  el("voiceVolume").value = Number.isFinite(vol)
    ? Math.max(0, Math.min(200, vol))
    : 100;
  syncVoiceVolumeLabel();
  syncVoiceFields();
  el("autoSpeak").checked = !!s.autoSpeak;
  el("showChatDebug").checked = s.showChatDebug === true;
  el("vadShadowEnabled").checked = s.vadShadowEnabled === true;
  el("personaCardId").value = s.personaCardId || "";
  if (el("memoryCardId")) el("memoryCardId").value = s.personaCardId || "";
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
  const memorySel = el("memoryCardId");
  if (memorySel) {
    const selected = memorySel.value;
    memorySel.replaceChildren(...Array.from(sel.options, (option) => option.cloneNode(true)));
    memorySel.value = Array.from(memorySel.options).some((option) => option.value === selected)
      ? selected
      : sel.value;
  }
  updateCardInfoDisplay();
}

async function onCardChanged() {
  const sel = el("personaCardId");
  const cardId = sel.value.trim();
  if (el("memoryCardId")) el("memoryCardId").value = cardId;

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
  applyVoiceForCard(cardId);
  syncVoiceFields();
  probeBackendStatus();
  updateCardLabels();
  if (el("tab-memory")?.classList.contains("active")) {
    await migrateSelectedCardMemory();
    await loadMemoryPage({ resetPage: true });
  }
}

/** 有仓库内置参考音的人设（assets/<cardId>/）；空 cardId = 默认开心元元。 */
const BUILTIN_LOCAL_VOICE_CARDS = new Set(["", "kxyy-yuanyuan", "bazi-persona", "elon-musk"]);

/** 切人设时套用该卡语音：优先卡级覆盖，否则内置卡默认走 local 且参考音留空（后端按 personaCardId 解析）。 */
function applyVoiceForCard(cardId) {
  const saved = loadCardVoice(cardId);
  if (saved && (saved.backend || saved.voice || saved.refWav || saved.refText || saved.model)) {
    el("realtimeBackend").value = normalizeBackend(saved.backend);
    el("ttsVoice").value = saved.voice || "";
    if (saved.backend === "volc" && saved.key) el("volcTtsKey").value = saved.key;
    if (saved.backend === "cosyvoice") {
      if (saved.model) el("cosyvoiceModel").value = saved.model;
      if (saved.cosyvoiceVoice) el("cosyvoiceVoice").value = saved.cosyvoiceVoice;
    }
    el("localRefWav").value = saved.refWav || "";
    el("localRefText").value = saved.refText || "";
    return;
  }
  if (BUILTIN_LOCAL_VOICE_CARDS.has(cardId || "")) {
    el("realtimeBackend").value = "local";
    el("localRefWav").value = "";
    el("localRefText").value = "";
  }
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

/** 当前人设显示名：完整名（开心元元）与口语短称（元元）。 */
function currentPersonaNames() {
  const cardId = el("personaCardId").value.trim();
  const opt = el("personaCardId").selectedOptions?.[0];
  const kxyy = isKxyyPersona(cardId);
  const full =
    (cardId && opt?.dataset?.name?.trim()) ||
    (kxyy ? "开心元元" : cardId || "AI");
  // 默认 kxyy 系列口语仍用「元元」；其它卡直接用显示名。
  const short =
    kxyy && (!cardId || full === "开心元元" || full.includes("元元"))
      ? "元元"
      : full;
  return { full, short, isKxyy: kxyy, cardId };
}

/** 人设相关 UI 文案跟随当前卡切换（含默认开心元元）。 */
function updateCardLabels() {
  const { full, short, isKxyy } = currentPersonaNames();

  const titleEl = el("personaUserProfileTitle");
  if (titleEl) titleEl.textContent = "观众画像";

  const userNameLabel = el("userNameLabel");
  const userNameInput = el("userName");
  if (userNameLabel) {
    userNameLabel.innerHTML = isKxyy
      ? "你的昵称<small>AI 如何称呼你，留空=元宝</small>"
      : "你的昵称<small>AI 如何称呼你，可留空</small>";
  }
  if (userNameInput) {
    userNameInput.placeholder = isKxyy ? "元宝" : "你的昵称";
  }

  const rel = el("personaRelationshipLabel");
  if (rel) rel.textContent = `你和${short}的关系`;
  const relInput = el("personaRelationship");
  if (relInput) {
    relInput.placeholder = isKxyy
      ? "比如：刚关注的萌新"
      : "比如：咨询者 / 长期提问的朋友";
  }

  const facts = el("personaFactsLabel");
  if (facts) facts.innerHTML = `想让${short}记住的事<small>每行一条</small>`;
  const factsInput = el("personaFacts");
  if (factsInput) {
    factsInput.placeholder = isKxyy
      ? "我在深圳上班\n我养了只橘猫叫团子"
      : "我的背景信息\n最近关心的问题";
  }

  const jokes = el("personaJokes");
  if (jokes) {
    jokes.placeholder = isKxyy
      ? "每次都催她唱《虫儿飞》"
      : "你们之间的专属说法 / 约定用语";
  }

  const treat = el("personaTreatAsLabel");
  if (treat) treat.textContent = `希望${short}怎么对待你`;
  const treatInput = el("personaTreatAs");
  if (treatInput) {
    treatInput.placeholder = isKxyy
      ? "把我当聊得来的朋友，别太客套"
      : "认真解答、先给结论再讲依据，别卖萌";
  }

  const hint = el("personaHint");
  if (hint) {
    hint.textContent = isKxyy
      ? `这些资料只在本机保存，会随对话注入，让${short}更懂你。留空就当普通粉丝「元宝」。`
      : `这些资料只在本机保存，会随对话注入，让${short}更懂你。`;
  }

  const memory = el("memoryHint");
  if (memory) {
    memory.textContent = `${short}会按昵称记住偏好、约定与对话概要（仅存本机）。清空后不再记得过往，当前聊天气泡不会自动消失。`;
  }

  const autoSpeak = el("autoSpeakLabel");
  if (autoSpeak) autoSpeak.textContent = `自动朗读${short}的回复`;

  const patLabel = el("patTextLabel");
  if (patLabel) {
    patLabel.innerHTML = `拍一拍文案<small>{name}=你的昵称，{ai}=${full}</small>`;
  }
  const patHint = el("patHint");
  if (patHint) {
    patHint.textContent = `双击聊天里${short}的头像即可「拍一拍」，会主动回你一句。`;
  }
}

async function deleteCurrentCard() {
  const sel = el("personaCardId");
  const cardId = sel.value.trim();
  if (!cardId) return;
  const opt = sel.selectedOptions?.[0];
  const name = opt?.dataset?.name || cardId;
  if (!window.confirm(`确定删除人设「${name}」？`)) return;
  try {
    await invoke("delete_persona_card", { cardId });
    await loadCardList();
    sel.value = "";
    _lastCardId = "";
    onCardChanged();
    statusEl.textContent = `已删除 ${name}`;
    statusEl.style.color = "#16a34a";
  } catch (e) {
    statusEl.textContent = `删除失败：${e}`;
    statusEl.style.color = "#dc2626";
  } finally {
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  }
}

async function exportCurrentCard() {
  const cardId = el("personaCardId").value.trim();
  if (!cardId) return;
  try {
    const raw = await invoke("export_persona_card", { cardId });
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    const dialog = window.__TAURI__?.dialog;
    if (dialog?.save) {
      const path = await dialog.save({
        defaultPath: `${cardId}.persona-card.json`,
        filters: [{ name: "persona card JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_utf8_file", { path, contents: pretty });
    } else {
      // 无 dialog.save 时退回浏览器下载
      const blob = new Blob([pretty], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cardId}.persona-card.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
    statusEl.textContent = "已导出";
    statusEl.style.color = "#16a34a";
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  } catch (e) {
    statusEl.textContent = `导出失败：${e}`;
    statusEl.style.color = "#dc2626";
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  }
}

function deriveImportCardId(card) {
  const fromMeta =
    (card?.meta?.card_id || card?.meta?.id || card?.meta?.cardId || "").trim();
  if (fromMeta) return fromMeta;
  const name = (card?.identity?.name || card?.meta?.name || "").trim();
  if (name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `imported-${Date.now()}`;
  }
  return `imported-${Date.now()}`;
}

async function importPersonaCard() {
  try {
    const dialog = window.__TAURI__?.dialog;
    let text;
    if (dialog?.open) {
      const selected = await dialog.open({
        multiple: false,
        filters: [{ name: "persona card JSON", extensions: ["json"] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      text = await invoke("read_utf8_file", { path });
    } else {
      text = await new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,application/json";
        inp.onchange = async () => {
          const f = inp.files?.[0];
          resolve(f ? await f.text() : null);
        };
        inp.click();
      });
      if (!text) return;
    }
    const card = JSON.parse(text);
    const cardId = deriveImportCardId(card);
    const name = await invoke("import_persona_card", {
      cardId,
      jsonContent: JSON.stringify(card),
    });
    await loadCardList();
    el("personaCardId").value = cardId;
    _lastCardId = cardId;
    statusEl.textContent = `已导入 ${name || cardId}`;
    statusEl.style.color = "#16a34a";
    onCardChanged();
    setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 2500);
  } catch (e) {
    statusEl.textContent = `导入失败：${e}`;
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
    asrProvider: currentAsrProvider(),
    turnPauseTolerance: currentTurnPauseTolerance(),
    voiceVolume: Math.max(
      0,
      Math.min(200, parseInt(el("voiceVolume").value, 10) || 100),
    ),
    autoSpeak: el("autoSpeak").checked,
    showChatDebug: el("showChatDebug").checked,
    vadShadowEnabled: el("vadShadowEnabled").checked,
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
    saveCardProfile(cardId, {
      userName: el("userName").value.trim(),
      relationship: el("personaRelationship").value.trim(),
      facts: el("personaFacts").value.trim(),
      jokes: el("personaJokes").value.trim(),
      treatAs: el("personaTreatAs").value.trim(),
    });
  }
  // 人设卡维度语音（含默认「开心元元」空 cardId）：保存后切卡可还原
  const bk = currentBackend();
  saveCardVoice(cardId, {
    backend: bk,
    voice: el("ttsVoice").value.trim(),
    key: bk === "volc" ? el("volcTtsKey").value.trim() : undefined,
    model: bk === "cosyvoice" ? el("cosyvoiceModel").value.trim() : undefined,
    cosyvoiceVoice: bk === "cosyvoice" ? el("cosyvoiceVoice").value.trim() : undefined,
    refWav: bk === "local" ? el("localRefWav").value.trim() : undefined,
    refText: bk === "local" ? el("localRefText").value.trim() : undefined,
  });
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
el("asrProvider")?.addEventListener("change", syncVoiceFields);
el("textProvider").addEventListener("change", () => {
  syncTextFields();
  probeLocalTextStatus();
});
el("vlProvider").addEventListener("change", syncVlFields);
el("voiceVolume").addEventListener("input", syncVoiceVolumeLabel);

el("installVadShadow")?.addEventListener("click", async () => {
  const btn = el("installVadShadow");
  const status = el("vadShadowInstallStatus");
  btn.disabled = true;
  status.style.color = "";
  status.textContent = "正在启动安装…";
  try {
    await invoke("install_vad_shadow_runtime", { backend: currentBackend() });
  } catch (e) {
    btn.disabled = false;
    status.style.color = "#dc2626";
    status.textContent = `无法安装：${e}`;
  }
});

el("installSenseVoiceRuntime")?.addEventListener("click", async () => {
  const btn = el("installSenseVoiceRuntime");
  const status = el("sensevoiceRuntimeInstallStatus");
  btn.disabled = true;
  status.style.color = "";
  status.textContent = "正在启动安装…";
  try {
    await invoke("install_sensevoice_runtime", { backend: currentBackend() });
  } catch (e) {
    btn.disabled = currentAsrProvider() !== "sensevoice";
    status.style.color = "#dc2626";
    status.textContent = `无法安装：${e}`;
  }
});

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
listen("vad-shadow-install-status", ({ payload }) => {
  const btn = el("installVadShadow");
  const status = el("vadShadowInstallStatus");
  if (!status) return;
  status.textContent = payload?.message || "";
  status.style.color = payload?.state === "failed" ? "#dc2626" : payload?.state === "ready" ? "#16a34a" : "";
  if (payload?.state === "failed" || payload?.state === "ready") {
    if (btn) btn.disabled = false;
  }
});
listen("sensevoice-runtime-install-progress", ({ payload }) => {
  const btn = el("installSenseVoiceRuntime");
  const status = el("sensevoiceRuntimeInstallStatus");
  if (!status) return;
  status.textContent = payload?.message || "";
  status.style.color = payload?.state === "failed" ? "#dc2626" : payload?.state === "ready" ? "#16a34a" : "";
  if (payload?.state === "failed" || payload?.state === "ready") {
    if (btn) btn.disabled = currentAsrProvider() !== "sensevoice";
  }
});

let memoryPage = 1;
let memoryTotal = 0;
let memoryCounts = { facts: 0, episodes: 0, commitments: 0 };
const MEMORY_PAGE_SIZE = 30;

function memoryKindLabel(kind) {
  return { fact: "事实", episode: "经历", commitment: "约定" }[kind] || kind;
}

function memoryStatusLabel(status) {
  return {
    active: "有效", disputed: "待确认", superseded: "已被替代", forgotten: "已遗忘",
    pending: "待兑现", fulfilled: "已兑现", cancelled: "已取消", expired: "已过期",
  }[status] || status;
}

function formatMemoryDate(ts) {
  if (!ts) return "";
  try { return new Date(ts * 1000).toLocaleDateString("zh-CN"); } catch (_) { return ""; }
}

async function migrateSelectedCardMemory() {
  const cardId = selectedMemoryCardId();
  try {
    await invoke("memory_import_legacy", { request: { cardId, memories: loadAllMemory(cardId) } });
  } catch (_) {}
}

function selectedMemoryCardId() {
  return (el("memoryCardId")?.value ?? el("personaCardId").value).trim();
}

async function refreshMemoryStats() {
  const box = el("memoryStats");
  const health = el("memoryHealth");
  if (!box) return;
  try {
    const status = await invoke("memory_status");
    const kb = Math.max(0, Math.round((status.databaseBytes || 0) / 1024));
    box.replaceChildren();
    for (const text of [
      status.available ? "Memory v3 已就绪" : "记忆数据库不可用",
      `事实 ${memoryCounts.facts || 0}`,
      `经历 ${memoryCounts.episodes || 0}`,
      `约定 ${memoryCounts.commitments || 0}`,
      `事件 ${status.eventCount || 0}`,
      `待巩固 ${status.pendingJobs || 0}`,
      `跳过 ${status.skippedJobs || 0}`,
      `数据库 ${kb} KB`,
    ]) {
      const span = document.createElement("span");
      span.textContent = text;
      box.appendChild(span);
    }
    box.title = status.lastError || "";
    const healthState = memoryHealthState(status);
    if (health) {
      health.hidden = !healthState;
      health.className = `memory-health${healthState ? ` ${healthState.kind}` : ""}`;
      health.textContent = healthState?.text || "";
    }
  } catch (e) {
    box.textContent = `读取状态失败：${e.message || e}`;
    if (health) {
      health.hidden = true;
      health.textContent = "";
    }
  }
}

function memoryActionButton(label, action, className = "ghost") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function startMemoryEdit(card, textElement, actions, item) {
  if (card.querySelector(".memory-edit")) return;
  const editor = document.createElement("div");
  editor.className = "memory-edit";
  const input = document.createElement("textarea");
  input.value = item.text || "";
  input.rows = item.kind === "episode" ? 4 : 3;
  input.maxLength = 1000;
  input.setAttribute("aria-label", "记忆内容");
  const editorActions = document.createElement("div");
  editorActions.className = "memory-edit-actions";
  const error = document.createElement("p");
  error.className = "memory-edit-error";
  const cancel = memoryActionButton("取消", () => {
    editor.remove();
    actions.hidden = false;
  });
  const save = memoryActionButton("保存", async () => {
    const next = input.value.trim();
    if (!next) {
      error.textContent = "记忆内容不能为空";
      input.focus();
      return;
    }
    if (next === item.text) {
      cancel.click();
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    error.textContent = "保存中…";
    try {
      await invoke("memory_update", { request: { kind: item.kind, id: item.id, text: next } });
      await loadMemoryPage();
    } catch (e) {
      save.disabled = false;
      cancel.disabled = false;
      error.textContent = `保存失败：${e.message || e}`;
    }
  });
  editorActions.append(cancel, save);
  editor.append(input, editorActions, error);
  textElement.hidden = true;
  card.insertBefore(editor, actions);
  actions.hidden = true;
  input.focus();
  input.select();
}

function renderMemoryTimeline(box, result) {
  box.replaceChildren();
  const events = Array.isArray(result?.events) ? result.events : [];
  const edges = Array.isArray(result?.edges) ? result.edges : [];
  if (!events.length) {
    if (!edges.length) box.textContent = "暂无可追溯事件";
  }
  if (edges.length) {
    const relations = document.createElement("div");
    relations.className = "memory-relations";
    const title = document.createElement("strong");
    title.textContent = "关系";
    relations.appendChild(title);
    const relationLabels = {
      about: "涉及主题",
      mentions: "提及实体",
      derived_from: "来源经历",
      supersedes: "替代事实",
    };
    for (const edge of edges) {
      const row = document.createElement("span");
      const target = edge.fromKind === result.itemKind && edge.fromId === result.itemId
        ? `${edge.toKind}:${edge.toLabel || edge.toId.slice(0, 8)}`
        : `${edge.fromKind}:${edge.fromLabel || edge.fromId.slice(0, 8)}`;
      row.textContent = `${relationLabels[edge.relation] || edge.relation} → ${target}`;
      relations.appendChild(row);
    }
    box.appendChild(relations);
  }
  if (!events.length) {
    return;
  }
  const eventLabels = {
    "episode.created": "创建经历",
    "episode.imported": "导入经历",
    "episode.edited": "编辑经历",
    "fact.created": "建立事实",
    "fact.imported": "导入事实",
    "fact.confirmed": "再次确认事实",
    "fact.corrected": "纠正事实",
    "fact.disputed": "标记事实冲突",
    "fact.superseded": "事实被替代",
    "fact.edited": "编辑事实",
    "commitment.created": "建立约定",
    "commitment.imported": "导入约定",
    "commitment.edited": "编辑约定",
    "commitment.status_changed": "约定状态变化",
    "commitment.pinned": "约定置顶变化",
  };
  const sourceLabels = {
    "chat-consolidation": "聊天巩固",
    "legacy-import": "旧版迁移",
    "user-edit": "用户操作",
    "schema-migration": "数据库迁移",
  };
  for (const event of events) {
    const row = document.createElement("div");
    row.className = "memory-event";
    const head = document.createElement("div");
    head.className = "memory-event-head";
    const type = document.createElement("strong");
    type.textContent = eventLabels[event.eventType] || event.eventType || "记忆事件";
    const date = document.createElement("time");
    date.textContent = event.observedAt
      ? new Date(event.observedAt * 1000).toLocaleString("zh-CN")
      : "时间未知";
    head.append(type, date);
    row.appendChild(head);
    const summary = document.createElement("p");
    summary.className = "memory-event-summary";
    summary.textContent = event.summary || "无摘要";
    row.appendChild(summary);
    const meta = document.createElement("p");
    meta.className = "memory-event-meta";
    meta.textContent = `${sourceLabels[event.sourceType] || event.sourceType || "来源未知"} · 信任度 ${Math.round((event.trust || 0) * 100)}% · ${event.consent || "权限未知"}`;
    row.appendChild(meta);
    for (const evidence of event.evidence || []) {
      const source = document.createElement("p");
      source.className = "memory-event-evidence";
      source.textContent = `${evidence.relation || "evidence"}${evidence.excerpt ? `：${evidence.excerpt}` : ""}`;
      row.appendChild(source);
    }
    box.appendChild(row);
  }
}

function renderMemoryItems(items) {
  const list = el("memoryList");
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "暂无符合条件的记忆";
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "memory-card";
    const head = document.createElement("div");
    head.className = "memory-card-head";
    const kind = document.createElement("span");
    kind.className = "memory-kind";
    kind.textContent = memoryKindLabel(item.kind);
    const meta = document.createElement("span");
    meta.className = "memory-card-meta";
    const confidence = item.kind === "fact" ? ` · 置信度 ${Math.round((item.confidence || 0) * 100)}%` : "";
    meta.textContent = `${item.nickname || "匿名"} · ${memoryStatusLabel(item.status)}${confidence}${item.occurredAt ? ` · ${formatMemoryDate(item.occurredAt)}` : ""}`;
    head.append(kind, meta);
    const text = document.createElement("p");
    text.className = "memory-card-text";
    text.textContent = item.text;
    card.append(head, text);
    if (item.sourceExcerpt) {
      const source = document.createElement("p");
      source.className = "memory-source";
      source.textContent = `来源片段\n${item.sourceExcerpt}`;
      card.appendChild(source);
    }
    const actions = document.createElement("div");
    actions.className = "memory-card-actions";
    actions.appendChild(memoryActionButton(item.pinned ? "取消置顶" : "置顶", async () => {
      await invoke("memory_update", { request: { kind: item.kind, id: item.id, pinned: !item.pinned } });
      await loadMemoryPage();
    }));
    actions.appendChild(memoryActionButton("编辑", async () => {
      startMemoryEdit(card, text, actions, item);
    }));
    if (item.kind === "commitment" && item.status === "pending") {
      actions.appendChild(memoryActionButton("标记已兑现", async () => {
        await invoke("memory_update", { request: { kind: item.kind, id: item.id, status: "fulfilled" } });
        await loadMemoryPage();
      }));
    }
    const timeline = document.createElement("div");
    timeline.className = "memory-timeline";
    timeline.hidden = true;
    const timelineButton = memoryActionButton("时间线", async () => {
      if (!timeline.hidden) {
        timeline.hidden = true;
        return;
      }
      timeline.hidden = false;
      timeline.textContent = "读取事件中…";
      try {
        const result = await invoke("memory_timeline", {
          query: {
            cardId: selectedMemoryCardId(),
            kind: item.kind,
            id: item.id,
            limit: 20,
          },
        });
        renderMemoryTimeline(timeline, result);
      } catch (e) {
        timeline.textContent = `读取时间线失败：${e.message || e}`;
      }
    });
    actions.appendChild(timelineButton);
    actions.appendChild(memoryActionButton("删除", async () => {
      if (!window.confirm("永久删除这条记忆？此操作不可撤销。")) return;
      await invoke("memory_delete", { request: { items: [{ kind: item.kind, id: item.id }] } });
      await loadMemoryPage();
    }, "danger"));
    card.append(actions, timeline);
    list.appendChild(card);
  }
}

let memoryView = "list";
let memoryGraphResult = null;
let memoryGraphSelectedKey = "";
let memoryGraphScene = null;
let memoryGraphZoom = 1;
let memoryGraphPan = { x: 0, y: 0 };
let memoryGraphLayout = { width: 1100, height: 560 };

const MEMORY_GRAPH_COLORS = {
  user: "#64748b",
  episode: "#d97706",
  fact: "#be567a",
  commitment: "#2563eb",
  topic: "#0f766e",
  entity: "#7c3aed",
};

function graphKey(node) {
  return `${node.kind}:${node.id}`;
}

function truncateGraphLabel(value, max = 18) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || "未命名";
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function graphLayout(nodes) {
  const kindOrder = ["user", "episode", "fact", "commitment", "topic", "entity"];
  const groups = new Map(kindOrder.map((kind) => [kind, []]));
  for (const node of nodes) (groups.get(node.kind) || groups.get("entity")).push(node);
  const maxRows = 18;
  const cellWidth = 112;
  const rowHeight = 29;
  const positions = new Map();
  const columnGroups = [];
  let xOffset = 42;
  let maxRowsUsed = 1;
  for (const kind of kindOrder) {
    const group = groups.get(kind);
    if (!group.length) continue;
    const columnCount = Math.max(1, Math.ceil(group.length / maxRows));
    const groupColumns = columnCount;
    const groupWidth = groupColumns * cellWidth;
    columnGroups.push({ kind, x: xOffset, width: groupWidth });
    group.forEach((node, index) => {
      const column = Math.floor(index / maxRows);
      const row = index % maxRows;
      positions.set(graphKey(node), {
        x: xOffset + column * cellWidth + cellWidth / 2,
        y: 70 + row * rowHeight,
      });
    });
    maxRowsUsed = Math.max(maxRowsUsed, Math.min(maxRows, group.length));
    xOffset += groupWidth + 28;
  }
  return {
    positions,
    columns: columnGroups,
    width: Math.max(760, xOffset + 20),
    height: Math.max(430, 110 + maxRowsUsed * rowHeight),
  };
}

function updateMemoryGraphTransform() {
  if (memoryGraphScene) {
    memoryGraphScene.setAttribute(
      "transform",
      `translate(${memoryGraphPan.x} ${memoryGraphPan.y}) scale(${memoryGraphZoom})`,
    );
  }
  const label = el("memoryGraphZoomLabel");
  if (label) label.textContent = `${Math.round(memoryGraphZoom * 100)}%`;
}

function setMemoryGraphZoom(next, resetPan = false) {
  memoryGraphZoom = Math.max(0.35, Math.min(3.5, next));
  if (resetPan) memoryGraphPan = { x: 0, y: 0 };
  updateMemoryGraphTransform();
}

function renderMemoryGraph(result) {
  const svg = el("memoryGraphSvg");
  const inspector = el("memoryGraphInspector");
  if (!svg) return;
  svg.replaceChildren();
  memoryGraphResult = result || { nodes: [], edges: [] };
  const nodes = Array.isArray(memoryGraphResult.nodes) ? memoryGraphResult.nodes : [];
  const edges = Array.isArray(memoryGraphResult.edges) ? memoryGraphResult.edges : [];
  if (memoryGraphSelectedKey && !nodes.some((node) => graphKey(node) === memoryGraphSelectedKey)) {
    memoryGraphSelectedKey = "";
  }
  const layout = graphLayout(nodes);
  memoryGraphLayout = layout;
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  const positions = layout.positions;
  const scene = svgElement("g", { class: "memory-graph-scene" });
  memoryGraphScene = scene;
  svg.appendChild(scene);
  for (const column of layout.columns) {
    const heading = svgElement("text", {
      x: column.x + column.width / 2,
      y: 28,
      "text-anchor": "middle",
      class: "memory-graph-column-heading",
    });
    heading.textContent = memoryKindLabel(column.kind);
    scene.appendChild(heading);
  }
  const showLabels = nodes.length <= 32;
  const nodeByKey = new Map(nodes.map((node) => [graphKey(node), node]));
  for (const edge of edges) {
    const from = positions.get(`${edge.fromKind}:${edge.fromId}`);
    const to = positions.get(`${edge.toKind}:${edge.toId}`);
    if (!from || !to) continue;
    const edgeLine = svgElement("line", {
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      class: `memory-graph-edge${edge.derived ? " derived" : ""}`,
    });
    scene.appendChild(edgeLine);
    const label = svgElement("text", {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - 4,
      "text-anchor": "middle",
      class: `memory-graph-edge-label${nodes.length > 24 ? " hidden" : ""}`,
    });
    label.textContent = edge.relation || "关系";
    scene.appendChild(label);
  }
  if (!nodes.length) {
    const empty = svgElement("text", { x: layout.width / 2, y: layout.height / 2, "text-anchor": "middle", class: "memory-graph-empty" });
    empty.textContent = "暂无符合条件的关系图节点";
    scene.appendChild(empty);
  }
  for (const node of nodes) {
    const point = positions.get(graphKey(node));
    const group = svgElement("g", {
      class: `memory-graph-node${memoryGraphSelectedKey === graphKey(node) ? " selected" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${node.kind}：${node.label || node.text}`,
    });
    const circle = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: node.pinned ? 19 : 15,
      fill: MEMORY_GRAPH_COLORS[node.kind] || "#64748b",
      opacity: node.status === "disputed" ? "0.62" : "0.92",
    });
    const text = svgElement("text", {
      x: point.x,
      y: point.y + 32,
      "text-anchor": "middle",
      class: showLabels || memoryGraphSelectedKey === graphKey(node) ? "" : "hidden",
    });
    text.textContent = truncateGraphLabel(node.label || node.text);
    group.append(circle, text);
    const title = svgElement("title");
    title.textContent = `${memoryKindLabel(node.kind)}：${node.label || node.text || "未命名"}`;
    group.appendChild(title);
    const select = () => {
      memoryGraphSelectedKey = graphKey(node);
      renderMemoryGraph(memoryGraphResult);
      renderMemoryGraphInspector(node, nodeByKey);
    };
    group.addEventListener("mouseenter", () => text.classList.remove("hidden"));
    group.addEventListener("mouseleave", () => {
      if (memoryGraphSelectedKey !== graphKey(node) && !showLabels) text.classList.add("hidden");
    });
    group.addEventListener("click", select);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
    scene.appendChild(group);
  }
  updateMemoryGraphTransform();
  if (inspector && !memoryGraphSelectedKey) inspector.hidden = true;
}

function renderMemoryGraphInspector(node, nodeByKey = new Map()) {
  const inspector = el("memoryGraphInspector");
  if (!inspector || !node) return;
  inspector.hidden = false;
  inspector.replaceChildren();
  const title = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${memoryKindLabel(node.kind)}：`;
  title.append(strong, document.createTextNode(node.label || node.text || "未命名"));
  const meta = document.createElement("p");
  meta.textContent = `状态：${memoryStatusLabel(node.status)} · 置信度：${Math.round((node.confidence || 0) * 100)}% · 重要度：${Math.round((node.importance || 0) * 100)}%${node.pinned ? " · 已置顶" : ""}`;
  const source = document.createElement("p");
  source.textContent = node.sourceEventIds?.length
    ? `来源事件：${node.sourceEventIds.slice(0, 3).join("、")}`
    : "来源事件：暂无";
  inspector.append(title, meta, source);
  if (node.text && node.text !== node.label) {
    const content = document.createElement("p");
    content.textContent = node.text;
    inspector.appendChild(content);
  }
  if (["fact", "episode", "commitment"].includes(node.kind)) {
    const button = memoryActionButton("在列表中查看", () => {
      memoryView = "list";
      updateMemoryViewButtons();
      el("memoryKind").value = node.kind;
      el("memorySearch").value = node.label || node.text || "";
      void loadMemoryPage({ resetPage: true });
    });
    inspector.appendChild(button);
  }
}

async function loadMemoryGraph() {
  const status = el("memoryGraphStatus");
  const refresh = el("memoryGraphRefresh");
  if (!el("memoryGraphPanel")) return;
  if (refresh) refresh.disabled = true;
  if (status) status.textContent = "读取关系图中…";
  try {
    const result = await invoke("memory_graph", {
      query: {
        cardId: selectedMemoryCardId(),
        nickname: el("memoryNickname").value.trim(),
        scope: el("memoryNickname").value.trim() ? "user" : "card",
        search: el("memorySearch").value.trim(),
        kind: el("memoryKind").value,
        status: el("memoryStatus").value,
        depth: Number(el("memoryGraphDepth")?.value || 1),
        maxNodes: Number(el("memoryGraphMaxNodes")?.value || 80),
      },
    });
    renderMemoryGraph(result);
    if (status) {
      const count = Array.isArray(result?.nodes) ? result.nodes.length : 0;
      status.textContent = `${count} 个节点 · ${result?.edges?.length || 0} 条关系${result?.truncated ? ` · 已按 ${result?.maxNodes || 200} 节点截断` : ""}`;
    }
  } catch (e) {
    renderMemoryGraph({ nodes: [], edges: [] });
    if (status) status.textContent = `读取关系图失败：${e.message || e}`;
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function updateMemoryViewButtons() {
  const listButton = el("memoryListView");
  const graphButton = el("memoryGraphView");
  const panel = el("memoryGraphPanel");
  const list = el("memoryList");
  const pagination = el("memoryPageInfo")?.parentElement;
  if (listButton) {
    listButton.classList.toggle("active", memoryView === "list");
    listButton.setAttribute("aria-selected", memoryView === "list" ? "true" : "false");
  }
  if (graphButton) {
    graphButton.classList.toggle("active", memoryView === "graph");
    graphButton.setAttribute("aria-selected", memoryView === "graph" ? "true" : "false");
  }
  if (panel) panel.hidden = memoryView !== "graph";
  if (list) list.hidden = memoryView === "graph";
  if (pagination) pagination.hidden = memoryView === "graph";
}

el("memoryListView")?.addEventListener("click", () => {
  memoryView = "list";
  updateMemoryViewButtons();
});
el("memoryGraphView")?.addEventListener("click", () => {
  memoryView = "graph";
  updateMemoryViewButtons();
  void loadMemoryGraph();
});
el("memoryGraphRefresh")?.addEventListener("click", () => void loadMemoryGraph());
el("memoryGraphDepth")?.addEventListener("change", () => {
  if (memoryView === "graph") void loadMemoryGraph();
});
el("memoryGraphMaxNodes")?.addEventListener("change", () => {
  if (memoryView === "graph") void loadMemoryGraph();
});
el("memoryGraphZoomIn")?.addEventListener("click", () => setMemoryGraphZoom(memoryGraphZoom * 1.25));
el("memoryGraphZoomOut")?.addEventListener("click", () => setMemoryGraphZoom(memoryGraphZoom / 1.25));
el("memoryGraphFit")?.addEventListener("click", () => setMemoryGraphZoom(1, true));

const memoryGraphViewport = el("memoryGraphViewport");
let memoryGraphPointer = null;
memoryGraphViewport?.addEventListener("pointerdown", (event) => {
  if (event.target.closest?.(".memory-graph-node")) return;
  memoryGraphPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...memoryGraphPan } };
  memoryGraphViewport.classList.add("dragging");
  memoryGraphViewport.setPointerCapture?.(event.pointerId);
});
memoryGraphViewport?.addEventListener("pointermove", (event) => {
  if (!memoryGraphPointer || memoryGraphPointer.id !== event.pointerId) return;
  const rect = memoryGraphViewport.getBoundingClientRect();
  const scaleX = memoryGraphLayout.width / Math.max(1, rect.width);
  const scaleY = memoryGraphLayout.height / Math.max(1, rect.height);
  memoryGraphPan = {
    x: memoryGraphPointer.pan.x + (event.clientX - memoryGraphPointer.x) * scaleX / memoryGraphZoom,
    y: memoryGraphPointer.pan.y + (event.clientY - memoryGraphPointer.y) * scaleY / memoryGraphZoom,
  };
  updateMemoryGraphTransform();
});
const finishMemoryGraphPointer = (event) => {
  if (!memoryGraphPointer || memoryGraphPointer.id !== event.pointerId) return;
  memoryGraphViewport.classList.remove("dragging");
  memoryGraphViewport.releasePointerCapture?.(event.pointerId);
  memoryGraphPointer = null;
};
memoryGraphViewport?.addEventListener("pointerup", finishMemoryGraphPointer);
memoryGraphViewport?.addEventListener("pointercancel", finishMemoryGraphPointer);
memoryGraphViewport?.addEventListener("wheel", (event) => {
  if (memoryView !== "graph") return;
  event.preventDefault();
  setMemoryGraphZoom(memoryGraphZoom * (event.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });

async function loadMemoryPage({ resetPage = false } = {}) {
  if (!el("memoryList")) return;
  if (resetPage) memoryPage = 1;
  const cardId = selectedMemoryCardId();
  try {
    const result = await invoke("memory_list", {
      query: {
        cardId,
        nickname: el("memoryNickname").value.trim(),
        kind: el("memoryKind").value,
        status: el("memoryStatus").value,
        search: el("memorySearch").value.trim(),
        page: memoryPage,
        pageSize: MEMORY_PAGE_SIZE,
      },
    });
    memoryTotal = result.total || 0;
    memoryCounts = result.counts || { facts: 0, episodes: 0, commitments: 0 };
    renderMemoryItems(result.items || []);
    const pages = Math.max(1, Math.ceil(memoryTotal / MEMORY_PAGE_SIZE));
    el("memoryPageInfo").textContent = `第 ${memoryPage} / ${pages} 页 · 共 ${memoryTotal} 条`;
    el("memoryPrev").disabled = memoryPage <= 1;
    el("memoryNext").disabled = memoryPage >= pages;
    await refreshMemoryStats();
    if (memoryView === "graph") await loadMemoryGraph();
  } catch (e) {
    el("memoryList").textContent = `读取记忆失败：${e.message || e}`;
  }
}

el("memoryRefresh")?.addEventListener("click", () => loadMemoryPage({ resetPage: true }));
for (const id of ["memoryNickname", "memoryKind", "memoryStatus"]) {
  el(id)?.addEventListener("change", () => loadMemoryPage({ resetPage: true }));
}
el("memoryCardId")?.addEventListener("change", async () => {
  await migrateSelectedCardMemory();
  await loadMemoryPage({ resetPage: true });
});
let memorySearchTimer = null;
el("memorySearch")?.addEventListener("input", () => {
  clearTimeout(memorySearchTimer);
  memorySearchTimer = setTimeout(() => loadMemoryPage({ resetPage: true }), 250);
});
el("memoryPrev")?.addEventListener("click", () => { if (memoryPage > 1) { memoryPage--; void loadMemoryPage(); } });
el("memoryNext")?.addEventListener("click", () => {
  if (memoryPage * MEMORY_PAGE_SIZE < memoryTotal) { memoryPage++; void loadMemoryPage(); }
});

function setMemoryMaintenanceStatus(text, ok = true) {
  const node = el("memoryMaintenanceStatus");
  if (!node) return;
  node.textContent = text;
  node.style.color = ok ? "#16a34a" : "#dc2626";
}

el("memoryIntegrity")?.addEventListener("click", async () => {
  const button = el("memoryIntegrity");
  button.disabled = true;
  setMemoryMaintenanceStatus("检查中…");
  try {
    const result = await invoke("memory_integrity_check");
    const counts = result.counts || {};
    if (result.ok) {
      setMemoryMaintenanceStatus(`完整性正常：${counts.events || 0} 个事件、${counts.edges || 0} 条关系边、${counts.searchRows || 0} 条搜索索引。`);
    } else {
      const details = (result.errors || []).slice(0, 2).join("；") || "发现未知问题";
      setMemoryMaintenanceStatus(`检查发现问题：${details}`, false);
    }
  } catch (e) {
    setMemoryMaintenanceStatus(`检查失败：${e.message || e}`, false);
  } finally {
    button.disabled = false;
  }
});

el("memoryRebuild")?.addEventListener("click", async () => {
  if (!window.confirm("重建搜索索引与关系边？\n\n这不会修改事件和长期记忆正文，但会重新生成 topic、entity、FTS 和关系边。")) return;
  const button = el("memoryRebuild");
  button.disabled = true;
  setMemoryMaintenanceStatus("重建中…");
  try {
    const result = await invoke("memory_rebuild_derived");
    setMemoryMaintenanceStatus(`重建完成：${result.rebuiltSearchRows || 0} 条索引、${result.rebuiltEdges || 0} 条关系边。`);
    await loadMemoryPage();
  } catch (e) {
    setMemoryMaintenanceStatus(`重建失败：${e.message || e}`, false);
  } finally {
    button.disabled = false;
  }
});

el("memoryExport")?.addEventListener("click", async () => {
  const button = el("memoryExport");
  button.disabled = true;
  setMemoryMaintenanceStatus("准备脱敏导出…");
  try {
    const result = await invoke("memory_export", {
      request: {
        cardId: selectedMemoryCardId(),
        nickname: el("memoryNickname").value.trim(),
      },
    });
    const blob = new Blob([result.json || "{}"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.fileName || "memory-export.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMemoryMaintenanceStatus(`已导出 ${result.itemCount || 0} 条记忆、${result.edgeCount || 0} 条关系边。`);
  } catch (e) {
    setMemoryMaintenanceStatus(`导出失败：${e.message || e}`, false);
  } finally {
    button.disabled = false;
  }
});

el("memoryBackup")?.addEventListener("click", async () => {
  const button = el("memoryBackup");
  button.disabled = true;
  setMemoryMaintenanceStatus("创建一致性备份…");
  try {
    const result = await invoke("memory_backup");
    const name = String(result.path || "").split(/[\\/]/).pop() || "memory backup";
    setMemoryMaintenanceStatus(`备份已创建：${name}（${Math.round((result.bytes || 0) / 1024)} KB，完整性 ${result.integrityResult}）。`);
  } catch (e) {
    setMemoryMaintenanceStatus(`备份失败：${e.message || e}`, false);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('.tab-btn[data-tab="memory"]')?.addEventListener("click", async () => {
  await migrateSelectedCardMemory();
  await loadMemoryPage({ resetPage: true });
});

async function clearCurrentCardMemory(statusNode, cardId = selectedMemoryCardId()) {
  await invoke("memory_clear_scope", { request: { cardId, nickname: "" } });
  clearAllMemory(cardId);
  await emit("memory-cleared", { cardId });
  if (statusNode) statusNode.textContent = "已清空";
  await loadMemoryPage({ resetPage: true });
}

el("clearMemory").addEventListener("click", async () => {
  const ok = window.confirm(
    "确定清空当前人设卡的长期记忆？\n\n此操作只清当前人设卡下的记忆，不影响其他人设卡的记忆。此操作不可撤销。",
  );
  if (!ok) return;
  const btn = el("clearMemory");
  const st = el("clearMemoryStatus");
  btn.disabled = true;
  try {
    await clearCurrentCardMemory(st, el("personaCardId").value.trim());
    st.style.color = "#16a34a";
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

el("memoryClearAll")?.addEventListener("click", async () => {
  if (!window.confirm("确定永久清空当前人设卡下全部长期记忆？\n\n数据库记录、来源片段和待巩固会话都会删除，此操作不可撤销。")) return;
  const btn = el("memoryClearAll");
  const st = el("memoryManageStatus");
  btn.disabled = true;
  try {
    await clearCurrentCardMemory(st);
    st.style.color = "#16a34a";
  } catch (e) {
    st.style.color = "#dc2626";
    st.textContent = `失败：${e.message || e}`;
  } finally {
    btn.disabled = false;
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
  await migrateSelectedCardMemory();
  _lastCardId = el("personaCardId").value.trim();
  updateCardInfoDisplay();
  if (_lastCardId) {
    let cardAv = loadCardAvatar(_lastCardId, "ai");
    if (!cardAv) { try { cardAv = await invoke("get_card_avatar", { cardId: _lastCardId }); } catch (e) {} }
    if (cardAv) aiAvatar = cardAv;
  }
  userAvatar = loadCardAvatar(_lastCardId || "", "user") || "";
  renderAvatars();
  updateCardLabels();
  probeBackendStatus();
  probeLocalTextStatus();
}

init();
