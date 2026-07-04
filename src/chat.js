// 浮层聊天控制器（桌面端精简版）。
// 逻辑复用 kxyy_ai_clone 的纯函数模块 persona.js / stickers.js（拼 prompt / 组装消息 / 拆条 / 表情）；
// UI 是本工程自写的轻量浮层。AI 请求经本地 Rust 代理（<apiBase>/api/chat）走 DeepSeek / 通义千问(VL)。
//
// 阶段 2：
//   A. 情绪驱动桌宠——聊天各阶段通过 Tauri 事件 "pet-chat" 通知 main 窗口驱动桌宠动作。
//   B. 表情包——回复里的 [表情:情绪] 标记渲染成 gif 贴纸气泡。
//   C. 看图(VL)——发图先经通义千问识图成文字描述，再让 DeepSeek 以元元口吻回应。

import {
  buildSystemPrompt,
  buildMessages,
  splitReply,
  sanitizeReply,
  replyMaxTokens,
  buildImageDescribeMessages,
  resolveUserProfile,
  loadMemory,
  getEffectiveName,
  updateMemoryAfterSession,
  updateRollingDigest,
  recapBoundary,
  getProactiveUserTrigger,
  proactiveWhoLabel,
  loadAssets,
  shouldDoFollowup,
  DEFAULT_FOLLOWUP_CHANCE,
  isHiddenUserMessage,
  getFollowupUserTrigger,
  isBadFollowupReply,
  detectDeepIntent,
  computeLiveContext,
} from "./ai/persona.js";
import {
  loadStickers,
  stickerEmotions,
  extractSticker,
  stripStickerForDisplay,
  pickSticker,
  userStickers,
  toSticker,
} from "./ai/stickers.js";
// 阶段 2·D：TTS 朗读（tts.js 内部相对 fetch("/api/tts") 由下方全局 fetch 改写转发到本地代理）。
import { speak, stopSpeak, unlockAudio, onTtsProgress } from "./ai/tts.js";
import { DEFAULT_AI_AVATAR, DEFAULT_USER_AVATAR } from "./ai/avatars.js";
// 实时语音通话：经 Rust 本地 WS 桥接连火山端到端实时语音大模型。
import { RealtimeSession } from "./ai/realtime.js";
import { setVoiceVolumePercent } from "./ai/voice-volume.js";

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const emit = window.__TAURI__.event.emit;

const MAX_TURNS = 6; // 送给模型的最近对话轮数
const STICKER_FREQUENCY = "medium"; // 适中：情绪到位时较常配表情
const IMAGE_DESCRIBE_MAX_TOKENS = 512;
const PAT_COOLDOWN_MS = 2500;
const DEFAULT_PAT_TEXT = "{name}拍了拍{ai}";
const AI_DISPLAY_NAME = "开心元元";
const DELETABLE_SEL = ".bubble[data-mid], .pat-notice[data-mid]";

// 自动朗读队列：主回复与 follow-up 等多条回复按顺序朗读，避免共用 token 时被误判为「关闭」。
let ttsQueue = Promise.resolve();
let ttsQueueGen = 0;

function resetTtsQueue() {
  ttsQueueGen++;
  ttsQueue = Promise.resolve();
}

/** 当前语音后端是否已具备自动朗读条件。 */
function canAutoSpeak() {
  if (!settings.autoSpeak) return false;
  const backend = (settings.realtimeBackend || "volc").toLowerCase();
  if (backend === "local") return true;
  if (
    backend === "cosyvoice3" ||
    backend === "cosyvoice3-local" ||
    backend === "cv3" ||
    backend === "indextts2" ||
    backend === "index-tts2" ||
    backend === "itts2"
  ) {
    return true;
  }
  if (backend === "cosyvoice" || backend === "cosy") {
    return !!(settings.cosyvoiceVoice || "").trim();
  }
  return !!(settings.ttsVoice || "").trim();
}

/** 把一段回复排进朗读队列（上一条播完再播下一条）。 */
function enqueueAutoSpeak(text, { token, voice } = {}) {
  const gen = ttsQueueGen;
  const backend = (settings.realtimeBackend || "volc").toLowerCase();
  // 火山才传 voice；本地 / CosyVoice(云/开源) 由后端按设置合成。
  const voiceOpt =
    backend === "volc" || backend === ""
      ? voice || (settings.ttsVoice || "").trim() || null
      : null;
  ttsQueue = ttsQueue
    .then(async () => {
      if (gen !== ttsQueueGen) return;
      await new Promise((resolve) => {
        speak(text, {
          token,
          voice: voiceOpt,
          onEnd: resolve,
          onError: resolve,
        }).then((started) => {
          if (!started) resolve();
        });
      });
    })
    .catch(() => {});
}

let apiBase = "";
/** @type {Awaited<ReturnType<typeof loadAssets>> | null} */
let assets = null;
let settings = {};
let busy = false;
let pendingImage = null; // { dataUrl } —— 待随下条消息发送的图片
let pendingSticker = null; // { url, emotion, ... } —— 待随下条消息发送的表情
const history = []; // { role, content, imageCaption?, images?, sticker?, pat?, id? }
let lastPatAt = 0;
let midDragActive = false;
let midDragStartY = 0;
let midDragStartScroll = 0;

// 全局 fetch 改写：复用的纯逻辑模块（tts.js / persona.js）内部用相对 fetch("/api/...")，
// 而桌面端 tauri://localhost 没有 /api 路由。这里把以 "/api/" 开头的相对请求统一改写到
// 本地 Rust 代理 apiBase（chat.js 自己用的是绝对地址 `${apiBase}/api/chat`，不受影响）。
const __nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/api/") && apiBase) {
    input = apiBase + input;
  }
  return __nativeFetch(input, init);
};

// 阶段 2·E：长期记忆（localStorage，按观众昵称分档，跨会话记住偏好/约定/概要）。
let activeProfile = null;   // 本轮生效的观众画像（本人 ππ / 自填 / 默认元宝）
let activeName = null;      // 当前生效昵称（记忆分档键；无有效昵称时为 null，不落盘）
let memory = {};            // 当前观众的长期记忆（loadMemory 读入，会话结束时增量总结）
let lastRememberedLen = 0;  // 已总结进记忆的 history 长度：只有新增消息才重新总结
// 超出实时窗口的较早内容滚动摘要（与网页版 useRecap 默认开一致）。
let sessionRecap = "";
let recapCovered = 0;
let recapUpdating = false;
// 本次运行的会话 id：供记忆里区分「聊过几次」。
const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const formEl = document.getElementById("composer");
const sendBtn = document.getElementById("send");
const attachBtn = document.getElementById("attach");
const fileEl = document.getElementById("file");
const previewEl = document.getElementById("attach-preview");
const thumbEl = document.getElementById("attach-thumb");
const attachRemoveBtn = document.getElementById("attach-remove");
const stickersBtn = document.getElementById("stickers-btn");
const callBtn = document.getElementById("call-btn");
const stickerPanel = document.getElementById("sticker-panel");
const stickerGrid = document.getElementById("sticker-grid");
const stickerPreviewEl = document.getElementById("sticker-preview");
const stickerThumbEl = document.getElementById("sticker-thumb");
const stickerRemoveBtn = document.getElementById("sticker-remove");

/** 通知 main 窗口驱动桌宠（失败静默，聊天不受影响）。 */
function petSignal(type, emotion) {
  emit("pet-chat", { type, emotion: emotion || "" }).catch(() => {});
}

function genMsgId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function userDisplayName() {
  return (settings.userName || "").trim() || "元宝";
}

function aiName() {
  return AI_DISPLAY_NAME;
}

function lastRealUserMessage() {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && !isHiddenUserMessage(m.content)) return m;
  }
  return null;
}

/** 增量更新较早聊天滚动摘要（fire-and-forget，不阻塞界面）。 */
async function maybeUpdateRecap() {
  if (recapUpdating) return;
  const boundary = recapBoundary(history, MAX_TURNS);
  if (recapCovered > boundary) recapCovered = boundary;
  const pending = history
    .slice(recapCovered, boundary)
    .filter((m) => (m.content || "").trim() && !isHiddenUserMessage(m.content));
  if (pending.length < 2) return;

  recapUpdating = true;
  const targetCovered = boundary;
  try {
    const next = await updateRollingDigest("", sessionRecap, pending);
    sessionRecap = next || sessionRecap;
    recapCovered = targetCovered;
  } catch (_) {
    /* 摘要失败静默：下轮再试 */
  } finally {
    recapUpdating = false;
  }
}

function resetRecap() {
  sessionRecap = "";
  recapCovered = 0;
}

function formatPatMessage() {
  const tpl = (settings.patText || DEFAULT_PAT_TEXT).trim() || DEFAULT_PAT_TEXT;
  return tpl.replace(/\{name\}/g, userDisplayName()).replace(/\{ai\}/g, aiName());
}

function aiAvatarSrc() {
  return (settings.aiAvatar || "").trim() || DEFAULT_AI_AVATAR;
}
function userAvatarSrc() {
  return (settings.userAvatar || "").trim() || DEFAULT_USER_AVATAR;
}

/** 生成一行的头像元素（AI/表情用元元头像，user 用我方头像）。 */
function createAvatar(role) {
  const av = document.createElement("div");
  av.className = "avatar";
  if (role !== "user") av.title = "双击拍一拍";
  const img = document.createElement("img");
  img.src = role === "user" ? userAvatarSrc() : aiAvatarSrc();
  img.alt = "";
  av.appendChild(img);
  return av;
}

const voiceDebugEl = document.getElementById("voice-debug");
const voiceDebugLabelEl = document.getElementById("voice-debug-label");
const voiceDebugBarEl = document.getElementById("voice-debug-bar");
const voiceDebugTtsMetaEl = document.getElementById("voice-debug-tts-meta");
const apiDebugMetaEl = document.getElementById("api-debug-meta");
const callDebugMetaEl = document.getElementById("call-debug-meta");

/** 在线 API 用量 debug 态（单次 usage + DeepSeek 余额；无「剩余 token」接口）。 */
const apiDebug = {
  provider: "",
  last: null, // { prompt, completion, total }
  sessionTotal: 0,
  balanceText: "",
};
/** TTS 计费字符（CosyVoice / 火山按字计费，非 LLM token）。 */
const ttsUsageDebug = {
  provider: "",
  lastBilled: 0,
  sessionBilled: 0,
};
/** 实时通话用量（火山端到端 token，或本地 DeepSeek+云端 TTS）。 */
const callUsageDebug = {
  provider: "",
  lastLine: "",
  sessionTokens: 0,
  sessionTtsChars: 0,
  estimated: false,
};
let balanceFetchSeq = 0;

/** 当前语音后端文案（朗读与通话共用）。 */
function voiceBackendLabel() {
  const backend = (settings.realtimeBackend || "volc").toLowerCase();
  if (backend === "local") return "本地 Qwen3-TTS（:9876 / :9976）";
  if (backend === "cosyvoice" || backend === "cosy") {
    return "CosyVoice 通义（:9877 / :9977）";
  }
  if (backend === "cosyvoice3" || backend === "cosyvoice3-local" || backend === "cv3") {
    return "CosyVoice3 本地开源（:9878 / :9978）";
  }
  if (backend === "indextts2" || backend === "index-tts2" || backend === "itts2") {
    return "IndexTTS-2 本地开源（:9879 / :9979）";
  }
  const voice = (settings.ttsVoice || "").trim();
  return voice ? `火山引擎 API（${voice}）` : "火山引擎 API";
}

function chatDebugEnabled() {
  return settings.showChatDebug !== false;
}

function formatTokenCount(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(2).replace(/\.?0+$/, "")}k`;
  return String(v);
}

/** 从 OpenAI 兼容响应体 / SSE chunk 提取 usage。 */
function extractUsage(obj) {
  const u = obj?.usage;
  if (!u || typeof u !== "object") return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || prompt + completion;
  if (!prompt && !completion && !total) return null;
  return { prompt, completion, total };
}

function formatUsageLine(usage) {
  if (!usage) return "";
  return `本次 ${formatTokenCount(usage.total)}（入${formatTokenCount(usage.prompt)}/出${formatTokenCount(usage.completion)}）`;
}

function updateApiDebug() {
  if (!apiDebugMetaEl) return;
  if (!chatDebugEnabled()) {
    apiDebugMetaEl.textContent = "";
    updateCallDebug();
    return;
  }
  const parts = ["API"];
  if (apiDebug.provider) parts.push(apiDebug.provider);
  if (apiDebug.last) {
    parts.push(formatUsageLine(apiDebug.last));
    if (apiDebug.sessionTotal > 0) {
      parts.push(`会话 ${formatTokenCount(apiDebug.sessionTotal)}`);
    }
  }
  if (apiDebug.balanceText) parts.push(apiDebug.balanceText);
  // 尚无任何用量/余额时不占行。
  if (parts.length <= 1) {
    apiDebugMetaEl.textContent = "";
  } else {
    const text = parts.join(" · ");
    apiDebugMetaEl.textContent = text;
    apiDebugMetaEl.title = text;
  }
  updateCallDebug();
}

function updateCallDebug() {
  if (!callDebugMetaEl) return;
  if (!chatDebugEnabled() || !callUsageDebug.lastLine) {
    callDebugMetaEl.textContent = "";
    return;
  }
  const parts = ["通话"];
  if (callUsageDebug.provider) parts.push(callUsageDebug.provider);
  parts.push(callUsageDebug.lastLine);
  if (callUsageDebug.sessionTokens > 0) {
    parts.push(`会话 ${formatTokenCount(callUsageDebug.sessionTokens)} tok`);
  }
  if (callUsageDebug.sessionTtsChars > 0) {
    parts.push(`TTS ${formatTokenCount(callUsageDebug.sessionTtsChars)}字`);
  }
  if (callUsageDebug.estimated) parts.push("约");
  const text = parts.join(" · ");
  callDebugMetaEl.textContent = text;
  callDebugMetaEl.title = text;
}

/** 实时通话一轮用量（火山 token 明细，或本地 LLM + TTS 字符）。 */
function noteCallUsage(msg) {
  if (!msg || typeof msg !== "object") return;
  const provider = (msg.provider || "").trim();
  if (provider) callUsageDebug.provider = provider;
  callUsageDebug.estimated = !!msg.estimated;

  const llm = msg.llm && typeof msg.llm === "object" ? msg.llm : null;
  const ttsChars = Number(msg.ttsCharacters) || 0;
  const total = Number(msg.total) || 0;

  if (llm) {
    const prompt = Number(llm.prompt) || 0;
    const completion = Number(llm.completion) || 0;
    const llmTotal = Number(llm.total) || prompt + completion;
    callUsageDebug.sessionTokens += llmTotal;
    const bits = [`LLM ${formatTokenCount(llmTotal)}`];
    if (ttsChars > 0) {
      callUsageDebug.sessionTtsChars += ttsChars;
      bits.push(`TTS ${formatTokenCount(ttsChars)}字`);
    }
    callUsageDebug.lastLine = `本轮 ${bits.join(" · ")}`;
  } else if (total > 0 || msg.inputAudioTokens != null) {
    const inText = Number(msg.inputTextTokens) || 0;
    const inAudio = Number(msg.inputAudioTokens) || 0;
    const outText = Number(msg.outputTextTokens) || 0;
    const outAudio = Number(msg.outputAudioTokens) || 0;
    const cached =
      (Number(msg.cachedTextTokens) || 0) + (Number(msg.cachedAudioTokens) || 0);
    const turnTotal =
      total || inText + inAudio + outText + outAudio + cached;
    callUsageDebug.sessionTokens += turnTotal;
    const detail = [
      inAudio ? `入音${formatTokenCount(inAudio)}` : "",
      inText ? `入文${formatTokenCount(inText)}` : "",
      outAudio ? `出音${formatTokenCount(outAudio)}` : "",
      outText ? `出文${formatTokenCount(outText)}` : "",
      cached ? `缓存${formatTokenCount(cached)}` : "",
    ]
      .filter(Boolean)
      .join("/");
    callUsageDebug.lastLine = detail
      ? `本轮 ${formatTokenCount(turnTotal)}（${detail}）`
      : `本轮 ${formatTokenCount(turnTotal)}`;
  } else {
    return;
  }
  updateCallDebug();
}

/** 记录一次在线 API 的 token 用量，并在 DeepSeek 时刷新余额。 */
function noteApiUsage(provider, usage, { refreshBalance = false } = {}) {
  if (!usage) return;
  apiDebug.provider = provider || apiDebug.provider;
  apiDebug.last = usage;
  apiDebug.sessionTotal += usage.total || 0;
  updateApiDebug();
  if (refreshBalance && provider === "DeepSeek") {
    void fetchDeepSeekBalance();
  }
}

function formatBalanceText(data) {
  const currency = (data?.currency || "").toString();
  const total = (data?.totalBalance ?? "").toString().trim();
  if (!total) return "";
  const symbol = currency === "USD" ? "$" : "¥";
  const avail = data?.isAvailable === false ? "（不足）" : "";
  return `余额 ${symbol}${total}${avail}`;
}

/** 拉取 DeepSeek 账户余额（金额；API 不提供「剩余 token」）。 */
async function fetchDeepSeekBalance() {
  if (!apiBase || !chatDebugEnabled()) return;
  const seq = ++balanceFetchSeq;
  try {
    const resp = await fetch(`${apiBase}/api/balance`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (seq !== balanceFetchSeq) return;
    apiDebug.balanceText = formatBalanceText(data);
    updateApiDebug();
  } catch (_) {
    /* 余额查询失败静默，不影响聊天 */
  }
}

function updateVoiceDebug() {
  if (!voiceDebugEl) return;
  const show = chatDebugEnabled();
  voiceDebugEl.hidden = !show;
  voiceDebugEl.setAttribute("aria-hidden", show ? "false" : "true");
  if (!show || !voiceDebugLabelEl) {
    updateApiDebug();
    return;
  }
  const vol = Number(settings.voiceVolume);
  const volPct = Number.isFinite(vol) ? Math.max(0, Math.min(200, vol)) : 100;
  const text = `语音 · ${voiceBackendLabel()} · 音量 ${volPct}%`;
  voiceDebugLabelEl.textContent = text;
  voiceDebugEl.title = text;
  updateApiDebug();
}

function formatTtsSeconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return s < 10 ? s.toFixed(2) : s.toFixed(1);
}

function formatTtsBillingSuffix() {
  if (!ttsUsageDebug.lastBilled && !ttsUsageDebug.sessionBilled) return "";
  const parts = [];
  if (ttsUsageDebug.provider) parts.push(ttsUsageDebug.provider);
  if (ttsUsageDebug.lastBilled > 0) {
    parts.push(`计费 ${formatTokenCount(ttsUsageDebug.lastBilled)}字`);
  }
  if (ttsUsageDebug.sessionBilled > 0) {
    parts.push(`会话 ${formatTokenCount(ttsUsageDebug.sessionBilled)}字`);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** TTS 合成进度 → debug 进度条与字速；在线后端附带计费字符。 */
function applyTtsProgress(ev) {
  if (!chatDebugEnabled() || !voiceDebugBarEl || !voiceDebugTtsMetaEl) return;
  const chars = Number(ev.chars) || 0;
  const ms = Number(ev.elapsedMs) || 0;
  const phase = ev.phase || "idle";
  const billed = Number(ev.billedChars) || 0;

  voiceDebugBarEl.classList.remove("idle", "synth", "done", "error", "cached");
  if (phase === "synth") {
    voiceDebugBarEl.classList.add("synth");
    const rate = ms > 0 ? ((chars / ms) * 1000).toFixed(1) : "…";
    voiceDebugTtsMetaEl.textContent = `合成中 ${formatTtsSeconds(ms)}s · ${chars}字 · ${rate}字/s`;
    return;
  }
  if (phase === "done") {
    if (ev.cached) {
      voiceDebugBarEl.classList.add("cached");
      const sess =
        ttsUsageDebug.sessionBilled > 0
          ? ` · 会话 ${formatTokenCount(ttsUsageDebug.sessionBilled)}字`
          : "";
      voiceDebugTtsMetaEl.textContent = `缓存命中 · ${chars}字（不计费）${sess}`;
    } else {
      if (billed > 0) {
        ttsUsageDebug.lastBilled = billed;
        ttsUsageDebug.sessionBilled += billed;
        if (ev.provider) ttsUsageDebug.provider = ev.provider;
      }
      voiceDebugBarEl.classList.add("done");
      const rate = ms > 0 ? ((chars / ms) * 1000).toFixed(1) : "—";
      const kb = ev.bytes ? ` · ${(ev.bytes / 1024).toFixed(1)}KB` : "";
      voiceDebugTtsMetaEl.textContent =
        `合成 ${formatTtsSeconds(ms)}s · ${chars}字 · ${rate}字/s${kb}${formatTtsBillingSuffix()}`;
    }
    return;
  }
  if (phase === "error") {
    voiceDebugBarEl.classList.add("error");
    voiceDebugTtsMetaEl.textContent = `失败 ${formatTtsSeconds(ms)}s · ${ev.error || "未知错误"}`;
    return;
  }
  // idle：只收起进度条动画，保留上次合成结果文案。
  voiceDebugBarEl.classList.add("idle");
}

onTtsProgress(applyTtsProgress);

/** 应用外观设置（字号）到根元素，并把已渲染气泡的头像刷新为最新设置。 */
function applyAppearance() {
  const fs = Number(settings.chatFontSize) || 14;
  document.documentElement.style.setProperty("--chat-font-size", `${fs}px`);
  messagesEl.querySelectorAll(".row").forEach((row) => {
    const img = row.querySelector(".avatar img");
    if (!img) return;
    img.src = row.classList.contains("user") ? userAvatarSrc() : aiAvatarSrc();
  });
  const vol = Number(settings.voiceVolume);
  setVoiceVolumePercent(Number.isFinite(vol) ? vol : 100);
  updateVoiceDebug();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addBubble(role, text, { mid } = {}) {
  const row = document.createElement("div");
  row.className = `row ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (mid) bubble.dataset.mid = mid;
  bubble.textContent = text;
  row.appendChild(createAvatar(role));
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollBottom();
  return bubble;
}

/** 拍一拍居中提示条（类微信系统消息）。 */
function appendPatNotice(text, { mid } = {}) {
  const div = document.createElement("div");
  div.className = "pat-notice";
  div.textContent = text;
  if (mid) div.dataset.mid = mid;
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

/** 用户气泡：文字 +（可选）图片缩略图 +（可选）表情贴纸。 */
function addUserBubble(text, imageDataUrl, sticker, { mid } = {}) {
  const row = document.createElement("div");
  row.className = "row user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (mid) bubble.dataset.mid = mid;
  // 纯表情（无文字无图）：用无底色贴纸气泡，和 AI 表情一致。
  if (sticker?.url && !text && !imageDataUrl) {
    bubble.classList.add("sticker-bubble");
    const img = document.createElement("img");
    img.src = sticker.url;
    img.alt = sticker.emotion || "表情";
    bubble.appendChild(img);
  } else {
    if (text) bubble.appendChild(document.createTextNode(text));
    if (imageDataUrl) {
      const img = document.createElement("img");
      img.className = "msg-image";
      img.src = imageDataUrl;
      bubble.appendChild(img);
    }
    if (sticker?.url) {
      const img = document.createElement("img");
      img.className = "msg-sticker";
      img.src = sticker.url;
      img.alt = sticker.emotion || "表情";
      bubble.appendChild(img);
    }
  }
  row.appendChild(createAvatar("user"));
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollBottom();
  return bubble;
}

/** 表情贴纸气泡（gif）。 */
function addStickerBubble(sticker, { linkedMid } = {}) {
  if (!sticker?.url) return;
  const row = document.createElement("div");
  row.className = "row sticker";
  if (linkedMid) row.dataset.linkedMid = linkedMid;
  const bubble = document.createElement("div");
  bubble.className = "bubble sticker-bubble";
  const img = document.createElement("img");
  img.src = sticker.url;
  img.alt = sticker.emotion || "表情";
  bubble.appendChild(img);
  row.appendChild(createAvatar("assistant"));
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollBottom();
}

function setBusy(next) {
  busy = next;
  sendBtn.disabled = next;
  inputEl.disabled = next;
  attachBtn.disabled = next;
  stickersBtn.disabled = next;
  if (!next) inputEl.focus();
}

// ---- 待发送图片 ----
function setPendingImage(dataUrl) {
  pendingImage = { dataUrl };
  thumbEl.src = dataUrl;
  previewEl.hidden = false;
  attachBtn.classList.add("has-image");
}

function clearPendingImage() {
  pendingImage = null;
  thumbEl.removeAttribute("src");
  previewEl.hidden = true;
  attachBtn.classList.remove("has-image");
}

function setPendingSticker(sticker) {
  pendingSticker = sticker;
  stickerThumbEl.src = sticker.url;
  stickerPreviewEl.hidden = false;
  stickersBtn.classList.add("has-sticker");
  inputEl.focus();
}

function clearPendingSticker() {
  pendingSticker = null;
  stickerThumbEl.removeAttribute("src");
  stickerPreviewEl.hidden = true;
  stickersBtn.classList.remove("has-sticker");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function loadConfig() {
  try {
    apiBase = await invoke("get_api_base");
  } catch (_) {}
  // apiBase 已就绪：上面安装的全局 fetch 改写会据此把 tts.js / persona.js 内部的
  // 相对 fetch("/api/...") 转发到本地 Rust 代理（tauri://localhost 没有 /api 路由）。
  try {
    assets = await loadAssets();
  } catch (_) {
    assets = {
      systemPrompt: "",
      fewShot: [],
      userProfile: {},
      lore: {},
      corrections: {},
    };
  }
  try {
    settings = (await invoke("get_settings")) || {};
  } catch (_) {}
  try {
    await loadStickers();
  } catch (_) {}
  applyAppearance();
  refreshIdentity();
  if (chatDebugEnabled()) void fetchDeepSeekBalance();
}

/** 把设置里的观众画像字段拼成一份「画像」对象（不含 nickname，昵称走 userName）。 */
function buildStoredProfileFromSettings(s) {
  const splitLines = (v) =>
    (v || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const profile = {};
  const rel = (s.personaRelationship || "").trim();
  if (rel) profile.relationship_with_yuan = { 关系: rel };
  const facts = splitLines(s.personaFacts);
  if (facts.length) profile.known_facts = facts;
  const jokes = splitLines(s.personaJokes);
  if (jokes.length) profile.inside_jokes = jokes;
  const treat = (s.personaTreatAs || "").trim();
  if (treat) profile.ai_should_treat_me_as = treat;
  return profile;
}

/** 依据当前昵称解析生效画像并载入其长期记忆（昵称变更 / 启动时调用）。
 *  - 昵称是本人「ππ」/真名 → 用打包好的完整个人画像（本人专属，省得每次填）。
 *  - 其它昵称 / 留空 → 只用「设置」里本人自填的画像字段，绝不带入打包的个人测试信息。 */
function refreshIdentity() {
  if (!assets) return;
  const name = (settings.userName || "").trim();
  const stored = buildStoredProfileFromSettings(settings);
  activeProfile = resolveUserProfile(assets.userProfile, name, stored);
  activeName = getEffectiveName(name, activeProfile);
  memory = activeName ? loadMemory(activeName) : {};
  lastRememberedLen = 0;
}

/** 会话结束（窗口收起 / 退出应用）时：把本次对话里的新增内容增量总结进长期记忆并落盘。
 *  无有效昵称、或自上次总结以来无新消息则跳过，避免空跑与重复消耗额度。
 *  并发调用共用同一个 Promise，避免收起与退出同时触发时重复总结。 */
let flushMemoryPromise = null;
async function flushMemory() {
  if (flushMemoryPromise) return flushMemoryPromise;
  flushMemoryPromise = (async () => {
    if (!activeName) return;
    if (history.length <= lastRememberedLen) return;
    const snapshotLen = history.length;
    try {
      // apiKey 传空：桌面端 DeepSeek Key 在 Rust 代理侧读取，前端无需带 x-api-key。
      const updated = await updateMemoryAfterSession("", activeName, memory, history, sessionId);
      if (updated) {
        memory = updated;
        lastRememberedLen = snapshotLen;
      }
    } catch (_) {}
  })().finally(() => {
    flushMemoryPromise = null;
  });
  return flushMemoryPromise;
}

function buildRequestMessages(opts = {}) {
  if (!assets) throw new Error("语料尚未加载");
  const name = (settings.userName || "").trim();
  // 画像来源：本人 ππ → 打包个人画像；其它 → 设置里自填的字段（refreshIdentity 已解析好）。
  // 是否把画像注入 system prompt 由「对话时加载观众画像」开关控制（默认开）。
  const profile = activeProfile
    || resolveUserProfile(assets.userProfile, name, buildStoredProfileFromSettings(settings));
  const useUserProfile = settings.loadPersona !== false;
  const systemPrompt = buildSystemPrompt(assets, {
    name: name || null,
    useUserProfile,
    // 阶段 2·E：注入长期记忆（renderMemoryBlock 会把 facts/promises/topics/上次概要带进 prompt）。
    memory,
    profile,
  });
  return buildMessages({
    systemPrompt,
    fewShot: assets.fewShot,
    history,
    maxTurns: MAX_TURNS,
    useLive: true,
    lore: assets.lore,
    stickerEmotions: stickerEmotions(),
    stickerFrequency: STICKER_FREQUENCY,
    proactiveKind: opts.proactiveKind,
    patAction: opts.patAction || "",
    who: proactiveWhoLabel(name || "元宝"),
    earlierRecap: sessionRecap,
    deep: opts.deep || false,
  });
}

/** 识图：通义千问 VL 只描述本轮图片（无历史、无人设），返回文字描述。 */
async function describeImage(imageDataUrl, userText) {
  const resp = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: buildImageDescribeMessages(imageDataUrl, userText),
      stream: false,
      provider: "vl",
      temperature: 0.2,
      max_tokens: IMAGE_DESCRIBE_MAX_TOKENS,
    }),
  });
  if (!resp.ok) {
    let err = `识图失败 ${resp.status}`;
    try {
      const j = await resp.json();
      err = j.error || err;
    } catch (_) {}
    throw new Error(err);
  }
  const data = await resp.json();
  noteApiUsage("通义千问", extractUsage(data));
  const caption = data.choices?.[0]?.message?.content?.trim();
  if (!caption) throw new Error("识图描述为空");
  return caption;
}

/** 最终回复按上游规则重排为多条气泡；reply 已剥离表情标记。 */
function renderFinalBubbles(streamBubble, reply) {
  const parts = splitReply(reply).filter(Boolean);
  if (!parts.length) {
    // 纯表情回复：移除空的流式气泡。
    streamBubble.closest(".row")?.remove();
    return;
  }
  streamBubble.textContent = parts[0];
  for (let i = 1; i < parts.length; i++) addBubble("assistant", parts[i]);
}

/** 流式请求元元回复（普通聊天 / 拍一拍共用）。调用前须已把本轮 user 消息写入 history。 */
async function streamAssistantReply(streamBubble, streamRow, { proactiveKind, patAction, replyId } = {}) {
  let full = "";
  let speaking = false;
  // 深聊模式：仅普通轮次（非拍一拍 / 非追问等主动开口）按观众用词判定；命中则本轮放开字数与
  // 拆条上限、注入「深聊但保持人设」提示，让元元能展开多聊，但性格口吻不变。
  const deep = !proactiveKind && detectDeepIntent(lastRealUserMessage()?.content || "");
  try {
    const resp = await fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: buildRequestMessages({ proactiveKind, patAction, deep }),
        stream: true,
        provider: "text",
        temperature: settings.temperature ?? 0.8,
        thinking: !!settings.thinking,
        max_tokens: replyMaxTokens({
          proactiveKind,
          lastUserMessage: proactiveKind ? null : lastRealUserMessage(),
          deep,
        }),
      }),
    });

    if (!resp.ok) {
      let err = `请求失败 ${resp.status}`;
      try {
        const j = await resp.json();
        err = j.error || err;
      } catch (_) {}
      throw new Error(err);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const chunkUsage = extractUsage(chunk);
          if (chunkUsage) usage = chunkUsage;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            if (!speaking) {
              speaking = true;
              petSignal("speaking");
            }
            streamBubble.textContent = stripStickerForDisplay(full);
            scrollBottom();
          }
        } catch (_) {
          /* 忽略半包 JSON */
        }
      }
    }
    noteApiUsage("DeepSeek", usage, { refreshBalance: true });

    const raw = sanitizeReply(full);
    const { text: reply, emotion } = extractSticker(raw);
    if (!reply && !emotion) throw new Error("回复为空");

    if (proactiveKind === "followup" && isBadFollowupReply(reply)) {
      streamRow.remove();
      return { skipped: true };
    }

    history.push({
      role: "assistant",
      content: reply,
      id: replyId,
      ...(emotion ? { sticker: { emotion } } : {}),
    });

    streamRow.classList.remove("streaming");
    renderFinalBubbles(streamBubble, reply);

    const replySticker = emotion ? pickSticker(emotion) : null;
    if (replySticker) addStickerBubble(replySticker, { linkedMid: replyId });

    petSignal("reply", emotion);

    if (canAutoSpeak() && reply) {
      enqueueAutoSpeak(reply, { token: replyId });
    }
    void maybeUpdateRecap();
    return { skipped: false };
  } catch (e) {
    streamRow.classList.remove("streaming");
    streamRow.classList.add("error");
    streamBubble.textContent = `出错了：${e.message || e}`;
    petSignal("abort");
    throw e;
  }
}

async function send(text, opts = {}) {
  text = (text || "").trim();
  const image = pendingImage;
  const sticker = opts.sticker || pendingSticker || null;
  if ((!text && !image && !sticker) || busy) return;
  setBusy(true);
  clearPendingImage();
  clearPendingSticker();
  closeStickerPanel();

  const userId = genMsgId();
  const replyId = genMsgId();
  addUserBubble(text, image?.dataUrl, sticker, { mid: userId });
  petSignal("user");

  const streamBubble = addBubble("assistant", "", { mid: replyId });
  const streamRow = streamBubble.closest(".row");
  streamRow.classList.add("streaming");
  petSignal("thinking");

  try {
    let caption = "";
    if (image) {
      streamBubble.textContent = "（正在看图…）";
      caption = await describeImage(image.dataUrl, text);
      streamBubble.textContent = "";
    }

    history.push({
      role: "user",
      content: text,
      id: userId,
      ...(caption ? { imageCaption: caption } : {}),
      ...(image ? { images: [image.dataUrl] } : {}),
      ...(sticker ? { sticker } : {}),
    });

    await streamAssistantReply(streamBubble, streamRow, { replyId });

    const reply = history[history.length - 1]?.content || "";
    if (shouldDoFollowup(text, reply, DEFAULT_FOLLOWUP_CHANCE)) {
      try {
        history.push({
          role: "user",
          content: getFollowupUserTrigger(),
          id: genMsgId(),
        });
        const followupReplyId = genMsgId();
        const followupBubble = addBubble("assistant", "", { mid: followupReplyId });
        const followupRow = followupBubble.closest(".row");
        followupRow.classList.add("streaming");
        petSignal("thinking");
        const { skipped } = await streamAssistantReply(followupBubble, followupRow, {
          proactiveKind: "followup",
          replyId: followupReplyId,
        });
        if (skipped) {
          if (history.length && history[history.length - 1]?.role === "user") {
            history.pop();
          }
        }
      } catch (_) {
        if (history.length && isHiddenUserMessage(history[history.length - 1]?.content)) {
          history.pop();
        }
      }
    }
  } catch (_) {
    /* streamAssistantReply 已渲染错误气泡 */
  } finally {
    setBusy(false);
    scrollBottom();
  }
}

/** 双击元元头像：拍一拍，触发俏皮主动回复。 */
async function triggerPat(avatarEl) {
  if (busy) return;
  const now = Date.now();
  if (now - lastPatAt < PAT_COOLDOWN_MS) return;
  lastPatAt = now;
  unlockAudio();

  if (avatarEl) {
    avatarEl.classList.remove("pat-flash");
    void avatarEl.offsetWidth;
    avatarEl.classList.add("pat-flash");
    setTimeout(() => avatarEl.classList.remove("pat-flash"), 450);
  }

  const patText = formatPatMessage();
  const patId = genMsgId();
  const replyId = genMsgId();
  appendPatNotice(patText, { mid: patId });
  history.push({ role: "user", content: patText, pat: true, id: patId });
  history.push({
    role: "user",
    content: getProactiveUserTrigger("pat"),
    id: genMsgId(),
  });

  petSignal("user");
  setBusy(true);

  const streamBubble = addBubble("assistant", "", { mid: replyId });
  const streamRow = streamBubble.closest(".row");
  streamRow.classList.add("streaming");
  petSignal("thinking");

  try {
    await streamAssistantReply(streamBubble, streamRow, {
      proactiveKind: "pat",
      patAction: patText,
      replyId,
    });
  } catch (_) {
    /* streamAssistantReply 已渲染错误气泡 */
  } finally {
    setBusy(false);
    scrollBottom();
  }
}

// ---- 实时语音通话 ----
let callSession = null;
let callActive = false;
// 一轮一气泡：ASR / 助手流式 token 都写进当前气泡，轮次结束再定稿。
let callUserBubble = null;
let callUserText = "";
let callAsstBubble = null;
let callAsstText = "";
let callWaveSpeaking = false;

const callWaveEl = document.getElementById("call-wave");
const callWaveBarsEl = callWaveEl?.querySelector(".call-wave-bars");
const CALL_WAVE_BAR_COUNT = 28;
let callWaveBars = [];

/** 组装实时通话用的人设 system_role：复用文字聊天的 buildSystemPrompt + 实时状态，
 *  再叠加「语音口语化」提示（说人话、简短、不要括号/表情/贴纸标记）。 */
function buildRealtimeSystemRole() {
  if (!assets) return "";
  const name = (settings.userName || "").trim();
  const profile = activeProfile
    || resolveUserProfile(assets.userProfile, name, buildStoredProfileFromSettings(settings));
  const useUserProfile = settings.loadPersona !== false;
  let sys = buildSystemPrompt(assets, {
    name: name || null,
    useUserProfile,
    memory,
    profile,
  });
  try {
    const live = computeLiveContext(new Date(), assets.lore);
    if (live) sys += "\n\n" + live;
  } catch (_) {}
  sys +=
    "\n\n# 语音通话模式\n\n" +
    "- 现在是**实时语音通话**，你的话会被念出来给对方听。说得像打电话一样自然口语、简短，一次别说太长。\n" +
    "- **不要**输出任何括号里的动作/神态描写、方括号、星号、表情符号或「[表情:xx]」这类标记——这些会被原样念出来，很怪。\n" +
    "- 想表达情绪就用语气词和说话方式本身，别靠文字符号。\n" +
    "- 你的名字是**元元**。用户叫的就是「元元」。语音识别经常把「元元」误听成「圆圆」「原原」「源源」「园园」等同音字——" +
    "你必须一律当作「元元」理解，**绝对不要**纠正用户叫错名字、也不要提「不是圆圆」之类的话。";
  return sys;
}

/** 通话 bot_name：用「元元」而非「开心元元」，便于 ASR 热词与人设对齐。 */
function callBotName() {
  return "元元";
}

function ensureCallWaveBars() {
  if (!callWaveBarsEl || callWaveBars.length) return;
  callWaveBarsEl.innerHTML = "";
  callWaveBars = [];
  for (let i = 0; i < CALL_WAVE_BAR_COUNT; i++) {
    const bar = document.createElement("span");
    // 中间高、两侧低的静态轮廓，安静时也有形状。
    const base = 0.18 + 0.55 * Math.sin((Math.PI * i) / (CALL_WAVE_BAR_COUNT - 1));
    bar.dataset.base = String(base);
    bar.style.height = `${Math.round(base * 100)}%`;
    callWaveBarsEl.appendChild(bar);
    callWaveBars.push(bar);
  }
}

function showCallWave(show) {
  if (!callWaveEl) return;
  if (show) {
    ensureCallWaveBars();
    callWaveEl.hidden = false;
    callWaveEl.setAttribute("aria-hidden", "false");
  } else {
    callWaveEl.hidden = true;
    callWaveEl.setAttribute("aria-hidden", "true");
    callWaveEl.classList.remove("speaking");
    callWaveSpeaking = false;
    for (const bar of callWaveBars) {
      const base = Number(bar.dataset.base) || 0.2;
      bar.style.height = `${Math.round(base * 100)}%`;
    }
  }
}

/** level ∈ [0,1]：麦克风与下行播放的合成电平。 */
function updateCallWave(level) {
  if (!callWaveBars.length || callWaveEl?.hidden) return;
  const t = performance.now() / 1000;
  const idle = 0.08 + 0.04 * Math.sin(t * 2.2);
  const amp = Math.max(idle, Math.min(1, level));
  for (let i = 0; i < callWaveBars.length; i++) {
    const bar = callWaveBars[i];
    const base = Number(bar.dataset.base) || 0.2;
    // 相位错开，形成从中心向外扩散的律动。
    const phase = t * 6 + i * 0.45;
    const wobble = 0.55 + 0.45 * Math.sin(phase);
    const h = Math.min(1, base * (0.35 + amp * 1.35 * wobble));
    bar.style.height = `${Math.max(12, Math.round(h * 100))}%`;
  }
}

function setCallActive(next) {
  callActive = next;
  callBtn.classList.toggle("in-call", next);
  callBtn.title = next ? "挂断" : "实时语音通话";
  callBtn.setAttribute("aria-label", next ? "挂断" : "实时语音通话");
  // 通话中锁定文字输入 / 发图 / 表情，避免两路音频与消息冲突。
  inputEl.disabled = next;
  sendBtn.disabled = next;
  attachBtn.disabled = next;
  stickersBtn.disabled = next;
  inputEl.placeholder = next
    ? "通话中…（点电话按钮挂断）"
    : "和元元说点什么…（Esc 收起）";
  showCallWave(next);
}

function finalizeCallUserBubble() {
  if (!callUserBubble) return;
  const text = (callUserText || "").trim();
  const mid = callUserBubble.dataset.mid || genMsgId();
  const row = callUserBubble.closest(".row");
  row?.classList.remove("streaming");
  callUserBubble = null;
  callUserText = "";
  // 语音轮次写入 history，收起/退出时才能进长期记忆，也与文字聊天共用上下文窗口。
  if (text) history.push({ role: "user", content: text, id: mid, call: true });
}

function finalizeCallAsstBubble() {
  if (!callAsstBubble) return;
  const text = (callAsstText || "").trim();
  const mid = callAsstBubble.dataset.mid || genMsgId();
  const row = callAsstBubble.closest(".row");
  row?.classList.remove("streaming");
  callAsstBubble = null;
  callAsstText = "";
  callWaveSpeaking = false;
  callWaveEl?.classList.remove("speaking");
  if (text) {
    history.push({ role: "assistant", content: text, id: mid, call: true });
    void maybeUpdateRecap();
  }
}

/** 用户一轮：中间态只更新同一气泡，asr_end / 终态后定稿。 */
function upsertCallUserBubble(text, { interim }) {
  const t = (text || "").trim();
  if (!t) return;
  if (t === callUserText && callUserBubble) return;
  callUserText = t;
  if (!callUserBubble) {
    // 用户开口时，先定稿上一轮助手气泡，避免两轮交错。
    finalizeCallAsstBubble();
    callUserBubble = addUserBubble(t, null, null, { mid: genMsgId() });
    callUserBubble.closest(".row")?.classList.add("streaming");
    petSignal("user");
  } else {
    callUserBubble.textContent = t;
    scrollBottom();
  }
  if (!interim) finalizeCallUserBubble();
}

/** 助手一轮：token 追加到同一气泡，assistant_end 定稿。 */
function appendCallAsstBubble(delta) {
  const d = delta || "";
  if (!d) return;
  // 助手开始回复时，定稿用户气泡（若 asr_end 尚未到）。
  finalizeCallUserBubble();
  callAsstText += d;
  if (!callAsstBubble) {
    callAsstBubble = addBubble("assistant", callAsstText, { mid: genMsgId() });
    callAsstBubble.closest(".row")?.classList.add("streaming");
    petSignal("reply");
  } else {
    callAsstBubble.textContent = callAsstText;
    scrollBottom();
  }
}

async function startCall() {
  if (callActive || busy) return;
  if (!assets) return;
  unlockAudio();
  // 通话与朗读互斥：先停掉正在放的朗读。
  stopSpeak();
  resetTtsQueue();
  callUserBubble = null;
  callUserText = "";
  callAsstBubble = null;
  callAsstText = "";

  setCallActive(true);
  appendPatNotice("📞 正在接通元元…");
  petSignal("thinking");

  callSession = new RealtimeSession({
    onState: (state) => {
      if (state === "started") {
        appendPatNotice("📞 通话已接通");
        petSignal("reply");
      } else if (state === "ended") {
        endCall({ notice: true });
      }
    },
    onAsrStart: () => {
      // 新一轮用户说话：定稿上一轮用户气泡（若有），并打断助手。
      finalizeCallUserBubble();
      finalizeCallAsstBubble();
      petSignal("user");
    },
    // ASR 全文是覆盖式更新；只在 asr_end 定稿，避免中间态被标成 final 时切成多条。
    onAsr: (text) => upsertCallUserBubble(text, { interim: true }),
    onAsrEnd: () => finalizeCallUserBubble(),
    onAssistant: (text) => appendCallAsstBubble(text),
    onAssistantEnd: () => finalizeCallAsstBubble(),
    onSpeaking: () => {
      callWaveSpeaking = true;
      callWaveEl?.classList.add("speaking");
      petSignal("speaking");
    },
    onUsage: (msg) => noteCallUsage(msg),
    onLevel: (level) => updateCallWave(level),
    onError: (e) => {
      appendPatNotice(`📞 通话出错：${e.message || e}`);
      endCall({ notice: false });
    },
  });

  // 必须在 await 之前、点击同步栈内解锁 Web Audio，否则首句 TTS 会静音。
  callSession.prepareAudio();

  try {
    await callSession.start({
      systemRole: buildRealtimeSystemRole(),
      botName: callBotName(),
    });
  } catch (e) {
    appendPatNotice(`📞 无法开始通话：${e.message || e}`);
    endCall({ notice: false });
  }
}

function endCall({ notice = true } = {}) {
  if (!callActive && !callSession) return;
  const s = callSession;
  callSession = null;
  finalizeCallUserBubble();
  finalizeCallAsstBubble();
  setCallActive(false);
  petSignal("abort");
  if (notice) appendPatNotice("📞 通话已结束");
  if (s) s.stop().catch(() => {});
}

function toggleCall() {
  if (callActive) endCall({ notice: true });
  else startCall();
}



/** 首次打开时懒填充表情网格（点选后进入待发送，可继续输入文字再发送）。 */
function buildStickerGrid() {
  if (stickerGridBuilt) return;
  const list = userStickers();
  stickerGrid.innerHTML = "";
  for (const s of list) {
    const sticker = toSticker(s);
    if (!sticker) continue;
    const cell = document.createElement("div");
    cell.className = "sticker-cell";
    cell.title = sticker.emotion || "表情";
    const img = document.createElement("img");
    img.src = sticker.url;
    img.alt = sticker.emotion || "表情";
    img.loading = "lazy";
    cell.appendChild(img);
    cell.addEventListener("click", () => {
      if (busy) return;
      unlockAudio();
      setPendingSticker(sticker);
      closeStickerPanel();
    });
    stickerGrid.appendChild(cell);
  }
  stickerGridBuilt = true;
}

function openStickerPanel() {
  buildStickerGrid();
  stickerPanel.hidden = false;
  stickersBtn.classList.add("on");
  scrollBottom();
}

function closeStickerPanel() {
  stickerPanel.hidden = true;
  stickersBtn.classList.remove("on");
}

function toggleStickerPanel() {
  if (stickerPanel.hidden) openStickerPanel();
  else closeStickerPanel();
}

// ---- 事件绑定 ----
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  // 在用户手势（提交）的同步栈内「加持」共享 <audio>，让稍后脱离手势的自动朗读也能 play()。
  unlockAudio();
  const text = inputEl.value;
  inputEl.value = "";
  send(text);
});

attachBtn.addEventListener("click", () => fileEl.click());
attachRemoveBtn.addEventListener("click", clearPendingImage);
stickerRemoveBtn.addEventListener("click", clearPendingSticker);
stickersBtn.addEventListener("click", toggleStickerPanel);
callBtn.addEventListener("click", toggleCall);

fileEl.addEventListener("change", async () => {
  const file = fileEl.files?.[0];
  fileEl.value = ""; // 允许再次选同一张
  if (!file || !file.type.startsWith("image/")) return;
  try {
    setPendingImage(await readFileAsDataUrl(file));
  } catch (_) {}
});

// 截图直接粘贴（Ctrl+V）
window.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type && it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (file) {
        e.preventDefault();
        try {
          setPendingImage(await readFileAsDataUrl(file));
        } catch (_) {}
      }
      return;
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideContextMenu();
    invoke("hide_chat").catch(() => {});
  }
});

// ---- 中键拖拽滚动（比滚轮更平滑的 1:1 跟手）----
function setupMiddleDragScroll() {
  messagesEl.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  messagesEl.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    midDragActive = true;
    midDragStartY = e.clientY;
    midDragStartScroll = messagesEl.scrollTop;
    messagesEl.classList.add("mid-dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (!midDragActive) return;
    messagesEl.scrollTop = midDragStartScroll - (e.clientY - midDragStartY);
  });

  window.addEventListener("mouseup", () => {
    if (!midDragActive) return;
    midDragActive = false;
    messagesEl.classList.remove("mid-dragging");
  });
}

// ---- 右键菜单：删除单条 / 清空记录 ----
function hideContextMenu() {
  document.getElementById("msg-context-menu")?.remove();
}

function resolveDeletable(target, x, y) {
  let el = target?.closest?.(DELETABLE_SEL) || null;
  if (!el && Number.isFinite(x) && Number.isFinite(y)) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const node of stack) {
      el = node.closest?.(DELETABLE_SEL) || null;
      if (el) break;
    }
  }
  return el;
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.id = "msg-context-menu";
  menu.className = "msg-context-menu";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `msg-context-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const vx = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const vy = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${vx}px`;
  menu.style.top = `${vy}px`;
}

function removeMessageDom(mid) {
  messagesEl.querySelectorAll(`[data-mid="${mid}"]`).forEach((el) => {
    const row = el.closest(".row");
    if (row) row.remove();
    else el.remove();
  });
  messagesEl.querySelectorAll(`[data-linked-mid="${mid}"]`).forEach((el) => el.remove());
}

function deleteMessageById(id) {
  if (!id || busy) return;
  const idx = history.findIndex((m) => m && m.id === id);
  if (idx === -1) return;
  history.splice(idx, 1);
  removeMessageDom(id);
}

function clearChatHistory() {
  if (busy) return;
  if (!confirm("清空当前对话？")) return;
  history.length = 0;
  messagesEl.innerHTML = "";
  lastRememberedLen = 0;
  resetRecap();
  stopSpeak();
  resetTtsQueue();
}

function setupContextMenu() {
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!e.target.closest("#messages")) return;
      e.preventDefault();
      const el = resolveDeletable(e.target, e.clientX, e.clientY);
      if (el) {
        const mid = el.dataset.mid;
        showContextMenu(e.clientX, e.clientY, [
          {
            label: "删除",
            danger: true,
            action: () => {
              if (confirm("删除这条聊天记录？")) deleteMessageById(mid);
            },
          },
        ]);
      } else {
        showContextMenu(e.clientX, e.clientY, [
          {
            label: "清空聊天记录",
            danger: true,
            action: clearChatHistory,
          },
        ]);
      }
    },
    true,
  );

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#msg-context-menu")) hideContextMenu();
  });
}

function setupPatAndDeletion() {
  messagesEl.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    const avatar = e.target.closest(".row.assistant .avatar, .row.sticker .avatar");
    if (!avatar) return;
    e.preventDefault();
    triggerPat(avatar);
  });
}

setupMiddleDragScroll();
setupContextMenu();
setupPatAndDeletion();

// 设置页保存后热更新（昵称 / 温度 / 思考模式 / 朗读音色 / 画像 / 头像 / 字号等）；
// 昵称或画像字段变更时重载画像与记忆。
listen("apply-settings", ({ payload }) => {
  if (!payload) return;
  const identityKeys = [
    "userName",
    "personaRelationship",
    "personaFacts",
    "personaJokes",
    "personaTreatAs",
  ];
  const identityChanged = identityKeys.some(
    (k) => k in payload && payload[k] !== settings[k]
  );
  const debugWasOn = settings.showChatDebug !== false;
  settings = { ...settings, ...payload };
  if (identityChanged) refreshIdentity();
  applyAppearance();
  // 刚打开 debug，或 DeepSeek Key 可能变更时，补拉一次余额。
  if (chatDebugEnabled() && (!debugWasOn || "deepseekKey" in payload)) {
    void fetchDeepSeekBalance();
  }
});

// 设置页清空长期记忆：同步内存态，并避免收起窗口时把当前会话再写回记忆。
listen("memory-cleared", () => {
  memory = {};
  lastRememberedLen = history.length;
});

/** 收起或退出前：挂断通话（把最后一轮写入 history）、停朗读，再刷长期记忆。 */
async function prepareAndFlushMemory() {
  if (callActive) endCall({ notice: false });
  stopSpeak();
  resetTtsQueue();
  await flushMemory();
}

// 聊天窗口收起时：停掉朗读，并把本次对话增量总结进长期记忆（阶段 2·D/E）。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void prepareAndFlushMemory();
  }
});

// 托盘「退出」：Rust 先发事件等我们落盘，完成后 invoke memory_flushed 再真正退出。
listen("flush-memory-before-quit", async () => {
  try {
    await prepareAndFlushMemory();
  } catch (_) {
  } finally {
    invoke("memory_flushed").catch(() => {});
  }
});

loadConfig().then(() => inputEl.focus());
