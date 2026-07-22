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
  normalizeModelNewlines,
  replyMaxTokens,
  buildImageDescribeMessages,
  resolveUserProfile,
  isKxyyPersona,
  loadMemory,
  getEffectiveName,
  updateMemoryAfterSession,
  updateRollingDigest,
  recapBoundary,
  getProactiveUserTrigger,
  proactiveWhoLabel,
  loadAssets,
  reloadAssets,
  shouldDoFollowup,
  DEFAULT_FOLLOWUP_CHANCE,
  isHiddenUserMessage,
  getFollowupUserTrigger,
  isBadFollowupReply,
  detectDeepIntent,
  computeLiveContext,
  parseBilingualReply,
  stripSpeakBlockForDisplay,
  needsBilingualTts,
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
import { synthesizeSpeech, playSpeechBlob, stopSpeak, unlockAudio, resetPlaybackPipeline, onTtsProgress, splitSpeechChunks } from "./ai/tts.js";
import { DEFAULT_AI_AVATAR, DEFAULT_AI_AVATAR_NEUTRAL, DEFAULT_USER_AVATAR } from "./ai/avatars.js";
// 实时语音通话：经 Rust 本地 WS 桥接连火山端到端实时语音大模型。
import { RealtimeSession } from "./ai/realtime.js";
import { setVoiceVolumePercent } from "./ai/voice-volume.js";

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const emit = window.__TAURI__.event.emit;

const MAX_TURNS = 6; // DeepSeek 等在线：送给模型的最近对话轮数
/** 本地 Ollama：人设已占 ~5k tokens，轮数再多容易顶穿上下文 → 400；比在线收紧一点。 */
const LOCAL_MAX_TURNS = 4;
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
  const backend = (settings.realtimeBackend || "").toLowerCase();
  if (!backend) return false; // 语音关闭
  if (backend === "local") return true;
  if (backend === "cosyvoice" || backend === "cosy") {
    return !!(settings.cosyvoiceVoice || "").trim();
  }
  return !!(settings.ttsVoice || "").trim();
}

/** 逐句显示器：保证每条气泡按顺序、只显示一次（不论来自音频回调、打断兜底还是合成失败）。
 *  首句复用流式气泡（去掉闪烁光标并填字），其余句在显示时才新建气泡。 */
function makeBubbleRevealer(parts, firstBubble, firstRow) {
  let next = 0;
  const revealUpTo = (target) => {
    while (next <= target && next < parts.length) {
      const i = next++;
      if (i === 0) {
        firstRow?.classList.remove("streaming");
        firstBubble.textContent = parts[0];
      } else {
        addBubble("assistant", parts[i]);
      }
    }
    scrollBottom();
  };
  return {
    revealUpTo,
    revealAll: () => revealUpTo(parts.length - 1),
  };
}

/** 同步朗读一段（已切分好的）回复：逐句合成音频，并在每句音频「开始播放」的瞬间
 *  才显示该句文字，实现文字与语音同步出现。采用预合成流水线：播放当前句时提前
 *  合成下一句，尽量消除句间空档。gen 变化（清空/通话/收起打断）或合成失败时，
 *  兜底把剩余文字直接补全，避免气泡永远停在闪烁光标。
 *  speakParts 与 parts 条数不一致时（双语）：按英文分段逐段朗读，开播时一次亮出全部中文气泡。 */
async function speakPartsSynced(parts, { revealer, voice, gen, speakParts } = {}) {
  const audioParts =
    Array.isArray(speakParts) && speakParts.length ? speakParts.filter(Boolean) : parts;
  if (!audioParts.length) {
    revealer.revealAll();
    return;
  }
  // 显示句与朗读句无法一一对应：按朗读分段逐段合成（勿合并成一段，否则会被 160 字上限截断）。
  const altAudio = Array.isArray(speakParts) && speakParts.length > 0;
  if (altAudio && audioParts.length !== parts.length) {
    let revealed = false;
    const revealOnce = () => {
      if (!revealed) {
        revealed = true;
        revealer.revealAll();
      }
    };
    let nextSynth = synthesizeSpeech(audioParts[0], { voice }).catch(() => null);
    for (let i = 0; i < audioParts.length; i++) {
      if (gen !== ttsQueueGen) {
        revealer.revealAll();
        return;
      }
      const blob = await nextSynth;
      nextSynth =
        i + 1 < audioParts.length
          ? synthesizeSpeech(audioParts[i + 1], { voice }).catch(() => null)
          : null;
      if (!blob) {
        revealOnce();
        continue;
      }
      await new Promise((resolve) => {
        playSpeechBlob(blob, {
          onStart: revealOnce,
          onError: revealOnce,
        }).then(() => {
          revealOnce();
          resolve();
        });
      });
    }
    revealer.revealAll();
    return;
  }

  let nextSynth = synthesizeSpeech(audioParts[0], { voice }).catch(() => null);
  for (let i = 0; i < audioParts.length; i++) {
    if (gen !== ttsQueueGen) {
      revealer.revealAll();
      return;
    }
    const blob = await nextSynth;
    // 播放本句前先起下一句的合成，藏进本句播放时长里。
    nextSynth =
      i + 1 < audioParts.length
        ? synthesizeSpeech(audioParts[i + 1], { voice }).catch(() => null)
        : null;

    if (!blob) {
      // 合成失败：无音频，直接把这句显示出来，继续下一句。
      revealer.revealUpTo(i);
      continue;
    }
    await new Promise((resolve) => {
      playSpeechBlob(blob, {
        onStart: () => revealer.revealUpTo(i),
        onError: () => revealer.revealUpTo(i),
      }).then(() => {
        revealer.revealUpTo(i);
        resolve();
      });
    });
  }
}

/** 把一段回复排进朗读队列，并让文字随语音逐句同步出现（上一条播完再播下一条）。
 *  parts 为已切分好的句子数组（气泡显示）；speakParts 可选，与 parts 不同时用于合成（如中文显示 / 英文朗读）。
 *  首句复用流式气泡 firstBubble。 */
function enqueueAutoSpeakSynced(parts, { firstBubble, firstRow, sticker, stickerMid, speakParts } = {}) {
  const gen = ttsQueueGen;
  const backend = (settings.realtimeBackend || "").toLowerCase();
  // 火山才传 voice；本地 / CosyVoice(云/开源) 由后端按设置合成。
  const voiceOpt =
    backend === "volc" || backend === ""
      ? (settings.ttsVoice || "").trim() || null
      : null;
  const revealer = makeBubbleRevealer(parts, firstBubble, firstRow);
  const finishSticker = () => {
    if (sticker) addStickerBubble(sticker, { linkedMid: stickerMid });
  };
  ttsQueue = ttsQueue
    .then(async () => {
      if (gen !== ttsQueueGen) {
        // 入队前已被打断：直接补全文字，不再合成。
        revealer.revealAll();
        finishSticker();
        return;
      }
      await speakPartsSynced(parts, { revealer, voice: voiceOpt, gen, speakParts });
      revealer.revealAll();
      finishSticker();
    })
    .catch(() => {
      revealer.revealAll();
      finishSticker();
    });
  // 返回「本条朗读全部完成」的 promise：供 followup 等第一行文字+语音出现后再出第二行。
  return ttsQueue;
}

let apiBase = "";
/** @type {Awaited<ReturnType<typeof loadAssets>> | null} */
let assets = null;
let settings = {};
let busy = false;
// 启动服务就绪状态：语音(voice) / AI 文字 API(api)
const svcState = { voice: "pending", api: "pending" };
let svcVoiceEventReceived = false;
let svcDismissTimer = null;
let pendingImage = null; // { dataUrl } —— 待随下条消息发送的图片
let pendingSticker = null; // { url, emotion, ... } —— 待随下条消息发送的表情
let stickerGridBuilt = false; // 表情网格是否已懒填充
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
  const name = (settings.userName || "").trim();
  if (name) return name;
  // 非 kxyy 人设（skill 卡）不留默认昵称
  return isKxyyPersona(settings.personaCardId) ? "元宝" : "";
}

function aiName() {
  // 优先用人设卡的 displayName（如 "郭德纲"），回退到默认 "开心元元"
  if (assets && assets.displayName) return assets.displayName;
  return AI_DISPLAY_NAME;
}

/** 口语短称：默认 kxyy 用「元元」，其它卡用完整显示名。 */
function aiShortName() {
  const name = aiName();
  if (isKxyyPersona(settings.personaCardId) && (name === AI_DISPLAY_NAME || name.includes("元元"))) {
    return "元元";
  }
  return name;
}

function updateInputPlaceholder() {
  if (!inputEl) return;
  inputEl.placeholder = callActive
    ? "通话中…（点电话按钮挂断）"
    : `和${aiShortName()}说点什么…（Esc 收起）`;
}

/** 非 kxyy 人设暂不开放实时语音与表情包：隐藏对应按钮并收尾进行中状态。 */
function updateKxyyOnlyControls() {
  const kxyy = isKxyyPersona(settings.personaCardId);
  if (callBtn) callBtn.hidden = !kxyy;
  if (stickersBtn) stickersBtn.hidden = !kxyy;
  if (!kxyy) {
    if (callActive) endCall({ notice: false });
    clearPendingSticker();
    closeStickerPanel();
  }
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
  const historyTurns = settings.textProvider === "local" ? LOCAL_MAX_TURNS : MAX_TURNS;
  const boundary = recapBoundary(history, historyTurns);
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
  const custom = (settings.aiAvatar || "").trim();
  if (custom) return custom;
  // 优先用人设卡自带的 avatar（data-url），其次由 setting 决定
  if (assets && assets.avatar) return assets.avatar;
  // 非 kxyy 人设（skill 卡）未配头像 → 用中性通用头像
  return isKxyyPersona(settings.personaCardId) ? DEFAULT_AI_AVATAR : DEFAULT_AI_AVATAR_NEUTRAL;
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
const voiceDebugTtsEl = document.getElementById("voice-debug-tts");
const voiceDebugTtsMetaEl = document.getElementById("voice-debug-tts-meta");
const personaDebugMetaEl = document.getElementById("persona-debug-meta");
const apiDebugMetaEl = document.getElementById("api-debug-meta");
const textDebugGenEl = document.getElementById("text-debug-gen");
const textDebugBarEl = document.getElementById("text-debug-bar");
const textDebugMetaEl = document.getElementById("text-debug-meta");
const callDebugMetaEl = document.getElementById("call-debug-meta");

/** 在线 / 本地文字 API 用量 debug 态（单次 usage + DeepSeek 余额；本地附带耗时）。 */
const apiDebug = {
  provider: "",
  model: "",
  last: null, // { prompt, completion, total }
  sessionTotal: 0,
  balanceText: "",
  lastElapsedMs: 0,
};
/** 本地文字生成进度（当前 Windows/mac 代理会缓冲整段 SSE，用计时不定条表示「生成中」）。 */
const textGenDebug = {
  active: false,
  startedAt: 0,
  timer: null,
  chars: 0,
  thinking: false,
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
  const backend = (settings.realtimeBackend || "").toLowerCase();
  if (!backend) return "已关闭";
  if (backend === "local") return "本地 Qwen3-TTS（:19876 / :19976）";
  if (backend === "cosyvoice" || backend === "cosy") {
    return "CosyVoice 通义（:19877 / :19977）";
  }
  const voice = (settings.ttsVoice || "").trim();
  return voice ? `火山引擎 API（${voice}）` : "火山引擎 API";
}

function chatDebugEnabled() {
  return settings.showChatDebug === true;
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

function formatGenSeconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return s < 10 ? s.toFixed(2) : s.toFixed(1);
}

function localTextModelLabel() {
  return (settings.localTextModel || "").trim() || "qwen3:14b";
}

function stopTextGenTimer() {
  if (textGenDebug.timer) {
    clearInterval(textGenDebug.timer);
    textGenDebug.timer = null;
  }
}

function setTextGenBarPhase(phase) {
  if (!textDebugBarEl) return;
  textDebugBarEl.classList.remove("idle", "gen", "done", "error");
  textDebugBarEl.classList.add(phase || "idle");
}

/** 本地文字：显示 / 刷新「生成中」进度行。 */
function beginLocalTextGen({ thinking = false } = {}) {
  stopTextGenTimer();
  textGenDebug.active = true;
  textGenDebug.startedAt = performance.now();
  textGenDebug.chars = 0;
  textGenDebug.thinking = !!thinking;
  if (!chatDebugEnabled()) return;
  if (textDebugGenEl) textDebugGenEl.hidden = false;
  setTextGenBarPhase("gen");
  const tick = () => {
    if (!textGenDebug.active || !textDebugMetaEl) return;
    const ms = performance.now() - textGenDebug.startedAt;
    const think = textGenDebug.thinking ? " · 思考开" : "";
    const chars =
      textGenDebug.chars > 0 ? ` · 已收 ${textGenDebug.chars} 字` : "";
    textDebugMetaEl.textContent = `生成中 ${formatGenSeconds(ms)}s${think}${chars}`;
  };
  tick();
  textGenDebug.timer = setInterval(tick, 200);
}

function noteLocalTextGenChars(n) {
  textGenDebug.chars = Math.max(0, Number(n) || 0);
}

/** 本地文字生成结束：进度条定稿 + 刷新用量行。 */
function finishLocalTextGen({ usage = null, error = null } = {}) {
  const elapsed = textGenDebug.active
    ? performance.now() - textGenDebug.startedAt
    : 0;
  stopTextGenTimer();
  textGenDebug.active = false;
  if (!chatDebugEnabled() || !textDebugMetaEl) {
    if (textDebugGenEl) textDebugGenEl.hidden = true;
    return elapsed;
  }
  if (textDebugGenEl) textDebugGenEl.hidden = false;
  if (error) {
    setTextGenBarPhase("error");
    textDebugMetaEl.textContent = `失败 ${formatGenSeconds(elapsed)}s · ${error}`;
    return elapsed;
  }
  setTextGenBarPhase("done");
  const parts = [`完成 ${formatGenSeconds(elapsed)}s`];
  if (usage?.completion) {
    const tps =
      elapsed > 0
        ? ((usage.completion / elapsed) * 1000).toFixed(1)
        : "—";
    parts.push(`${formatTokenCount(usage.completion)} tok`);
    parts.push(`${tps} tok/s`);
  } else if (textGenDebug.chars > 0) {
    parts.push(`${textGenDebug.chars} 字`);
  }
  textDebugMetaEl.textContent = parts.join(" · ");
  return elapsed;
}

function updateApiDebug() {
  if (!apiDebugMetaEl) return;
  if (!chatDebugEnabled()) {
    apiDebugMetaEl.textContent = "";
    if (textDebugGenEl && !textGenDebug.active) textDebugGenEl.hidden = true;
    updateCallDebug();
    return;
  }
  const parts = ["API"];
  if (apiDebug.provider) parts.push(apiDebug.provider);
  if (apiDebug.provider === "本地模型" && apiDebug.model) {
    parts.push(apiDebug.model);
  }
  if (apiDebug.last) {
    parts.push(formatUsageLine(apiDebug.last));
    if (apiDebug.lastElapsedMs > 0 && apiDebug.provider === "本地模型") {
      parts.push(`${formatGenSeconds(apiDebug.lastElapsedMs)}s`);
      if (apiDebug.last.completion > 0) {
        const tps = (
          (apiDebug.last.completion / apiDebug.lastElapsedMs) *
          1000
        ).toFixed(1);
        parts.push(`${tps} tok/s`);
      }
    }
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

/** 记录一次 API 的 token 用量；DeepSeek 可顺带刷新余额，本地可附带耗时。 */
function noteApiUsage(
  provider,
  usage,
  { refreshBalance = false, model = "", elapsedMs = 0 } = {}
) {
  if (!usage && !provider) return;
  if (provider) apiDebug.provider = provider;
  if (model) apiDebug.model = model;
  if (usage) {
    apiDebug.last = usage;
    apiDebug.sessionTotal += usage.total || 0;
  }
  if (elapsedMs > 0) apiDebug.lastElapsedMs = elapsedMs;
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

/** 更新启动状态栏：用语音 / AI 两个圆点表示服务就绪情况。
 *  人设切换等场景会再次拉起本地语音模型；若栏已 dismiss，需重新亮起。 */
function updateStartupStatus() {
  const bar = document.getElementById("startup-status");
  if (!bar) return;
  const voiceDone = svcState.voice === "ready" || svcState.voice === "stopped";
  const apiDone = svcState.api === "ready";
  const allReady = voiceDone && apiDone;
  // 任一服务离开就绪态（重载 / 失败 / 探测中）→ 取消消失计时并重新显示
  if (!allReady) {
    if (svcDismissTimer) {
      clearTimeout(svcDismissTimer);
      svcDismissTimer = null;
    }
    bar.classList.remove("dismissed");
  } else if (bar.classList.contains("dismissed")) {
    // 已消失且仍全部就绪：无需再刷 UI（避免短暂 ready 误闪）
    return;
  }
  // 更新圆点 class
  for (const key of Object.keys(svcState)) {
    const dot = bar.querySelector(`.svc-dot.${key}`);
    const label = bar.querySelector(`.svc-dot.${key} + .svc-label`);
    if (!dot) continue;
    dot.className = `svc-dot ${key} ${svcState[key]}`;
    // 状态文字提示
    const statusText =
      svcState[key] === "ready" ? "就绪" :
      svcState[key] === "loading" ? "启动中…" :
      svcState[key] === "failed" ? "异常" :
      svcState[key] === "pending" ? "待检测" :
      svcState[key] === "stopped" ? "已关闭" : "";
    if (label) label.textContent = `${key === "voice" ? "语音" : "AI"} ${statusText}`;
  }
  // 全部就绪/已关闭（视为就绪）→ 短暂停留后消失
  if (allReady) {
    if (!svcDismissTimer) {
      svcDismissTimer = setTimeout(() => {
        bar.classList.add("dismissed");
        svcDismissTimer = null;
      }, 4000);
    }
  }
  // 出现失败项 → 不清除，保留错误可视
}

/** 确保 apiBase 可用：为空时尝试通过 IPC 再次获取，失败则等 1s 后重试（最多 5 次）。 */
async function ensureApiBase() {
  if (apiBase) return true;
  for (let i = 0; i < 5; i++) {
    try {
      apiBase = await invoke("get_api_base");
      if (apiBase) return true;
    } catch (_) { /* 重试 */ }
    if (i < 4) await new Promise((r) => setTimeout(r, 1000));
  }
  return !!apiBase;
}

/** 同步检查 AI 文字 API 连通性（走 Rust 代理的 GET /api/chat 探针，零费用）。 */
async function checkApiReady() {
  if (!apiBase) {
    // apiBase 未被 loadConfig 成功设置：尝试补救（可能 IPC 就绪晚于 DOM）
    const ok = await ensureApiBase();
    if (!ok) {
      svcState.api = "failed";
      updateStartupStatus();
      return;
    }
  }
  svcState.api = "loading";
  updateStartupStatus();
  try {
    const resp = await fetch(`${apiBase}/api/chat`, { signal: AbortSignal.timeout(5000) });
    // 本地 Rust 代理只要响应即就绪（Key 未配 ≠ 服务不可用）
    svcState.api = resp.ok ? "ready" : "failed";
  } catch (_) {
    svcState.api = "failed";
  }
  updateStartupStatus();
}

function updatePersonaDebug() {
  if (!personaDebugMetaEl) return;
  if (!chatDebugEnabled()) {
    personaDebugMetaEl.textContent = "";
    return;
  }
  const cardId = settings?.personaCardId || "";
  const displayName = assets?.displayName || "";
  if (isKxyyPersona(cardId)) {
    personaDebugMetaEl.textContent = cardId
      ? `人设 · kxyy（${displayName || "开心元元"}）`
      : `人设 · ${displayName || "开心元元"}`;
  } else {
    personaDebugMetaEl.textContent = cardId
      ? `人设 · ${cardId}（${displayName || cardId}）`
      : "人设 · 开心元元";
  }
}

function updateVoiceDebug() {
  if (!voiceDebugEl) return;
  const show = chatDebugEnabled();
  voiceDebugEl.hidden = !show;
  // 显式后备：防止某些 WebView2 环境下 hidden 属性未能正确联动 CSS display
  voiceDebugEl.style.display = show ? "" : "none";
  voiceDebugEl.setAttribute("aria-hidden", show ? "false" : "true");
  updatePersonaDebug();
  if (!show || !voiceDebugLabelEl) {
    stopTextGenTimer();
    if (textDebugGenEl) textDebugGenEl.hidden = true;
    updateApiDebug();
    return;
  }
  const vol = Number(settings.voiceVolume);
  const volPct = Number.isFinite(vol) ? Math.max(0, Math.min(200, vol)) : 100;
  const voiceOff = !settings.realtimeBackend || !String(settings.realtimeBackend).trim();
  const lines = [`语音 · ${voiceBackendLabel()} · 音量 ${volPct}%`];
  // 语音关闭时隐藏 TTS 进度条区域（否则会残留上次 synthing/done/idle 的样式）
  if (voiceDebugTtsEl) voiceDebugTtsEl.hidden = voiceOff;
  if (settings.textProvider === "local") {
    lines.push(`文字 · 本地 ${localTextModelLabel()}`);
  }
  const text = lines.join("\n");
  voiceDebugLabelEl.textContent = lines[0];
  // 第二行挂在 label 上：本地文字后端一眼可见。
  if (lines[1]) {
    voiceDebugLabelEl.textContent = `${lines[0]}\n${lines[1]}`;
  }
  voiceDebugEl.title = text;
  if (textDebugGenEl && !textGenDebug.active && !textDebugMetaEl?.textContent) {
    textDebugGenEl.hidden = true;
  }
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
  updateInputPlaceholder();
  updateKxyyOnlyControls();
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
  console.log("[startup-status] loadConfig called");
  // Windows WebView2 有时会在 Rust setup() 完成 app.manage(AppState) 前就执行到这里。
  // 首次 IPC 此时会报 state 尚未注册；不能静默回退到空 settings，否则本次窗口会一直
  // 使用默认 kxyy 人设，直到设置页再次保存并通过 apply-settings 把配置推过来。
  apiBase = await invokeWithStartupRetry("get_api_base");
  // apiBase 已就绪：上面安装的全局 fetch 改写会据此把 tts.js / persona.js 内部的
  // 相对 fetch("/api/...") 转发到本地 Rust 代理（tauri://localhost 没有 /api 路由）。
  settings = (await invokeWithStartupRetry("get_settings")) || {};
  console.log("[loadConfig] 启动配置就绪:", {
    personaCardId: settings.personaCardId || "",
    showChatDebug: settings.showChatDebug === true,
  });
  // 先用 reloadAssets（清缓存 + 重新 fetch），且带重试——启动时 HTTP 服务端可能还未就绪。
  try {
    assets = await reloadAssetsWithRetry();
  } catch (_) {
    assets = {
      systemPrompt: "",
      fewShot: [],
      userProfile: {},
      lore: {},
      corrections: {},
    };
  }
  // 后端返回资产必须与持久化的人格 ID 一致，避免启动竞态时缓存编译期默认人设。
  const expectedCardId = (settings.personaCardId || "").trim();
  const actualCardId = (assets.activeCardId || "").trim();
  if ((expectedCardId && actualCardId !== expectedCardId) || (!expectedCardId && actualCardId)) {
    try {
      assets = await reloadAssetsWithMatchingCard(expectedCardId);
    } catch (e) {
      console.error("[loadConfig] 人格资产与设置不一致:", e);
      throw e;
    }
  }
  try {
    await loadStickers();
  } catch (_) {}
  applyAppearance();
  refreshIdentity();
  if (settings.textProvider !== "local" && chatDebugEnabled()) void fetchDeepSeekBalance();
  // 启动服务状态探测
  scheduleStartupStatusCheck();
}

/**
 * 启动期 IPC 重试：Tauri 的配置窗口会先创建，Windows WebView2 可能早于 Rust
 * setup() 中的 AppState 注册完成。只用于无参数、依赖 AppState 的只读命令。
 */
async function invokeWithStartupRetry(command, maxRetries = 30, delayMs = 100) {
  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await invoke(command);
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs + 50, 500);
      }
    }
  }
  throw new Error(`启动 IPC ${command} 在 ${maxRetries} 次重试后仍未就绪：${lastError}`);
}

/** 带重试的 reloadAssets：启动时 HTTP 服务器可能尚未就绪，等几秒再试。 */
async function reloadAssetsWithRetry(maxRetries = 4, delayMs = 600) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await reloadAssets();
    } catch (e) {
      if (i < maxRetries - 1) {
        console.log(`[loadConfig] loadAssets 第 ${i + 1} 次失败，${delayMs}ms 后重试...`, e);
        await new Promise(r => setTimeout(r, delayMs));
        // 递增延迟：600 → 1200 → 2000 → 3000
        delayMs = Math.min(delayMs + 600, 3000);
      } else {
        throw e;
      }
    }
  }
}

async function reloadAssetsWithMatchingCard(expectedCardId, maxRetries = 4, delayMs = 250) {
  let lastAssets = null;
  for (let i = 0; i < maxRetries; i++) {
    lastAssets = await reloadAssets();
    if ((lastAssets.activeCardId || "").trim() === expectedCardId) return lastAssets;
    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 1200);
    }
  }
  throw new Error(`人格资产不匹配：期望 ${expectedCardId || "默认"}，实际 ${lastAssets?.activeCardId || "默认"}`);
}

/** 聊天窗口首次加载时，探测语音/AI 服务就绪状态。 */
function scheduleStartupStatusCheck() {
  console.log("[startup-status] scheduleStartupStatusCheck, backend:", settings.realtimeBackend);
  // 语音：volc 无需本地服务 → 直接视为就绪；本地后端等 voice-service-status 事件。
  const backend = (settings.realtimeBackend || "").toLowerCase();
  if (!backend) {
    svcState.voice = "stopped";
  } else if (backend === "volc") {
    svcState.voice = "ready";
  } else {
    svcState.voice = "loading";
  }
  updateStartupStatus();
  // 如果 2 秒内未收到 voice-service-status 事件 → 用 Rust 命令主动查询（窗口晚于服务启动的情况）
  setTimeout(() => {
    if (svcState.voice === "loading" && !svcVoiceEventReceived) {
      void checkVoiceServiceViaRust();
    }
  }, 2000);
  // AI API 异步探针
  void checkApiReady();
}

/** 通过 Rust IPC 命令查询当前语音后端服务是否在跑。 */
async function checkVoiceServiceViaRust() {
  try {
    const result = await invoke("check_voice_service");
    if (result && result.state === "running") {
      svcState.voice = "ready";
    } else if (result && result.state === "unknown") {
      // 仍在加载中，保持 loading；不会标记为 failed（可能模型较大加载慢）
    }
  } catch (_) {
    /* 静默 */
  }
  updateStartupStatus();
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
  activeProfile = resolveUserProfile(assets.userProfile, name, stored, settings.personaCardId);
  activeName = getEffectiveName(name, activeProfile);
  memory = activeName ? loadMemory(settings.personaCardId || "", activeName) : {};

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
      const updated = await updateMemoryAfterSession("", settings.personaCardId || "", activeName, memory, history, sessionId);
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
    || resolveUserProfile(assets.userProfile, name, buildStoredProfileFromSettings(settings), settings.personaCardId);
  const useUserProfile = settings.loadPersona !== false;
  const systemPrompt = buildSystemPrompt(assets, {
    name: name || null,
    useUserProfile,
    // 阶段 2·E：注入长期记忆（renderMemoryBlock 会把 facts/promises/topics/上次概要带进 prompt）。
    memory,
    profile,
  });
  const maxTurns = settings.textProvider === "local" ? LOCAL_MAX_TURNS : MAX_TURNS;
  const stickerFreq = isKxyyPersona(settings.personaCardId) ? STICKER_FREQUENCY : "off";
  const reqDebug = `cardId=${settings.personaCardId} sticker=${stickerFreq} sys=${(systemPrompt || "").substring(0,60)}`;
  console.log("[buildRequestMessages]", reqDebug);
  if (apiDebugMetaEl) { apiDebugMetaEl.textContent = "REQ " + reqDebug; apiDebugMetaEl.title = reqDebug; }
  return buildMessages({
    systemPrompt,
    fewShot: assets.fewShot,
    history,
    maxTurns,
    useLive: true,
    lore: assets.lore,
    cardId: settings.personaCardId,
    stickerEmotions: stickerEmotions(),
    stickerFrequency: stickerFreq,
    proactiveKind: opts.proactiveKind,
    patAction: opts.patAction || "",
    who: proactiveWhoLabel(name || userDisplayName() || "你"),
    earlierRecap: sessionRecap,
    deep: opts.deep || false,
    tts: assets.tts,
  });
}

/** 识图：通义千问 VL 只描述本轮图片（无历史、无人设），返回文字描述。 */
async function describeImage(imageDataUrl, userText) {
  if (!apiBase || !apiBase.startsWith("http://")) {
    throw new Error("API 代理未就绪，无法识图");
  }
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
  const vlProvider = settings.vlProvider === "local" ? "本地看图" : "通义千问";
  noteApiUsage(vlProvider, extractUsage(data));
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

/**
 * 正文为空时，依据流式过程中收集到的线索判定「回复为空」的真实原因，
 * 便于排查：连接其实是通的（否则前面就报「连接DeepSeek失败/错误码」了）。
 */
function emptyReplyReason({ finishReason, hasReasoning, sawData } = {}) {
  if (!sawData) {
    return "回复为空：未收到任何模型数据（响应体空或被截断，检查网络/上游状态；也可能是 API 代理端口未就绪：尝试重启应用）";
  }
  if (finishReason === "content_filter") {
    return "回复为空：内容被 DeepSeek 安全策略过滤，换个说法再试";
  }
  if (hasReasoning) {
    return finishReason === "length"
      ? "回复为空：深度思考占满了 max_tokens，正文没生成完（关闭「深度思考」或调大 max_tokens）"
      : "回复为空：模型只输出了思考内容、没有正文";
  }
  if (finishReason === "length") {
    return "回复为空：输出被长度限制截断";
  }
  return "回复为空";
}

/** 流式请求元元回复（普通聊天 / 拍一拍共用）。调用前须已把本轮 user 消息写入 history。 */
async function streamAssistantReply(streamBubble, streamRow, { proactiveKind, patAction, replyId } = {}) {
  let full = "";
  let speaking = false;
  // 是否会自动朗读本条回复。会朗读时，流式期间**不**实时灌字进气泡（保持闪烁光标），
  // 待整段生成完后逐句「文字 + 语音」同步出现；否则维持即时流式显示。
  const willSync = canAutoSpeak();
  // 深聊模式：仅普通轮次（非拍一拍 / 非追问等主动开口）按观众用词判定；命中则本轮放开字数与
  // 拆条上限、注入「深聊但保持人设」提示，让元元能展开多聊，但性格口吻不变。
  const deep = !proactiveKind && detectDeepIntent(lastRealUserMessage()?.content || "");
  const isLocalText = settings.textProvider === "local";
  let localGenStarted = false;
  try {
    // 防御：apiBase 必须是以 http 开头的绝对地址，否则会变成相对 URL
    // 发到 tauri://localhost/api/chat（返回 HTML 无 data: 行 → "回复为空"）。
    if (!apiBase || !apiBase.startsWith("http://")) {
      const ok = await ensureApiBase();
      if (!ok || !apiBase.startsWith("http://")) {
        throw new Error("API 代理未就绪：请先确保本地服务端口可用，或重启应用后重试");
      }
    }
    if (isLocalText) {
      beginLocalTextGen({ thinking: !!settings.thinking });
      localGenStarted = true;
    }
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
        // 本地 400 详情里常有 exceed_context；error 已是可读文案，detail 仅作 debug。
        if (chatDebugEnabled() && j.detail) {
          console.warn("[chat] upstream detail", j.detail);
        }
      } catch (_) {}
      throw new Error(err);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    // 排查「回复为空」用的线索：是否真收到过 SSE 数据、是否只有思考内容、上游给的结束原因。
    let reasoning = "";
    let finishReason = "";
    let sawData = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        sawData = true;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const chunkUsage = extractUsage(chunk);
          if (chunkUsage) usage = chunkUsage;
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const rc = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
          if (rc) reasoning += rc;
          const delta = choice?.delta?.content;
          if (delta) {
            full += delta;
            if (isLocalText) noteLocalTextGenChars(full.length);
            if (!speaking) {
              speaking = true;
              petSignal("speaking");
            }
            // 会朗读时先不显示文字，等对应句音频开始播放再显示（同步出现）。
            if (!willSync) {
              streamBubble.textContent = stripStickerForDisplay(
                stripSpeakBlockForDisplay(normalizeModelNewlines(full))
              );
              scrollBottom();
            }
          }
        } catch (_) {
          /* 忽略半包 JSON */
        }
      }
    }
    // 本地模型（Ollama）没有余额概念，仅 DeepSeek 才刷新余额。
    const elapsedMs = localGenStarted
      ? finishLocalTextGen({ usage })
      : 0;
    noteApiUsage(isLocalText ? "本地模型" : "DeepSeek", usage, {
      refreshBalance: !isLocalText,
      model: isLocalText ? localTextModelLabel() : "",
      elapsedMs,
    });
    localGenStarted = false;

    const normalized = normalizeModelNewlines(full);
    const bilingual = parseBilingualReply(normalized);
    const raw = sanitizeReply(bilingual.display);
    const speakText = (bilingual.speak || "").trim();
    const useSpeakAlt =
      needsBilingualTts(assets?.tts) &&
      bilingual.bilingual &&
      speakText &&
      speakText !== raw;
    const { text: reply, emotion } = extractSticker(raw);
    if (!reply && !emotion) {
      if (chatDebugEnabled()) {
        console.warn("[chat] 回复为空", { finishReason, hasReasoning: !!reasoning, sawData, fullLen: full.length });
      }
      throw new Error(emptyReplyReason({ finishReason, hasReasoning: !!reasoning, sawData }));
    }

    if (proactiveKind === "followup") {
      // 上一条真实助手回复（主气泡）；history 末尾此时还是「续说」幕后 user 触发。
      let prevAssistant = "";
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.role === "assistant") {
          prevAssistant = history[i].content || "";
          break;
        }
      }
      if (isBadFollowupReply(reply, prevAssistant)) {
        streamRow.remove();
        return { skipped: true };
      }
    }

    history.push({
      role: "assistant",
      content: reply,
      id: replyId,
      ...(emotion ? { sticker: { emotion } } : {}),
    });

    petSignal("reply", emotion);

    const replySticker = emotion ? pickSticker(emotion) : null;
    // 会朗读时：切句后走「文字随语音逐句同步出现」流水线（首句复用流式气泡）。
    const syncParts =
      willSync && canAutoSpeak() && reply
        ? splitReply(reply).filter(Boolean)
        : null;
    const speakParts =
      syncParts && useSpeakAlt
        ? splitSpeechChunks(speakText)
        : null;
    // 双语卡若模型漏了 [[speak]]：只显示中文，别用英文参考音硬读中文。
    const skipSpeakMissingEn =
      needsBilingualTts(assets?.tts) && !useSpeakAlt;
    if (skipSpeakMissingEn && chatDebugEnabled()) {
      console.warn("[chat] 双语卡缺 [[speak]] 英文稿，跳过朗读", {
        bilingual: bilingual.bilingual,
        speakLen: speakText.length,
        displayLen: raw.length,
      });
    }

    // speechDone：本条回复「文字+语音」全部同步出现完成的 promise（不朗读时为 null）。
    let speechDone = null;
    if (syncParts && syncParts.length && !skipSpeakMissingEn) {
      speechDone = enqueueAutoSpeakSynced(syncParts, {
        firstBubble: streamBubble,
        firstRow: streamRow,
        sticker: replySticker,
        stickerMid: replyId,
        speakParts,
      });
    } else {
      // 不朗读（或纯表情回复 / 双语缺英文稿）：按原有逻辑立即定稿多条气泡。
      streamRow.classList.remove("streaming");
      renderFinalBubbles(streamBubble, reply);
      if (replySticker) addStickerBubble(replySticker, { linkedMid: replyId });
    }

    void maybeUpdateRecap();
    return { skipped: false, speechDone };
  } catch (e) {
    if (localGenStarted) {
      finishLocalTextGen({ error: e.message || String(e) });
      localGenStarted = false;
    }
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

    const mainResult = await streamAssistantReply(streamBubble, streamRow, { replyId });

    const reply = history[history.length - 1]?.content || "";
    if (shouldDoFollowup(text, reply, DEFAULT_FOLLOWUP_CHANCE)) {
      // 先等主回复「文字+语音」同步出现完成，再出 followup 第二行，避免两行光标同时冒出。
      if (mainResult?.speechDone) {
        try {
          await mainResult.speechDone;
        } catch (_) {
          /* 朗读异常不阻塞 followup */
        }
      }
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
    || resolveUserProfile(assets.userProfile, name, buildStoredProfileFromSettings(settings), settings.personaCardId);
  const useUserProfile = settings.loadPersona !== false;
  let sys = buildSystemPrompt(assets, {
    name: name || null,
    useUserProfile,
    memory,
    profile,
  });
  try {
    const live = computeLiveContext(new Date(), assets.lore, settings.personaCardId);
    if (live) sys += "\n\n" + live;
  } catch (_) {}
  sys +=
    "\n\n# 语音通话模式\n\n" +
    "- 现在是**实时语音通话**，你的话会被念出来给对方听。说得像打电话一样自然口语、简短，一次别说太长。\n" +
    "- **不要**输出任何括号里的动作/神态描写、方括号、星号、表情符号或「[表情:xx]」这类标记——这些会被原样念出来，很怪。\n" +
    "- 想表达情绪就用语气词和说话方式本身，别靠文字符号。\n";
  const bot = aiShortName();
  if (isKxyyPersona(settings.personaCardId)) {
    sys +=
      "- 你的名字是**元元**。用户叫的就是「元元」。语音识别经常把「元元」误听成「圆圆」「原原」「源源」「园园」等同音字——" +
      "你必须一律当作「元元」理解，**绝对不要**纠正用户叫错名字、也不要提「不是圆圆」之类的话。";
  } else {
    sys +=
      `- 你的名字是**${bot}**。用户叫的就是「${bot}」。语音识别若听错近音字，一律当作「${bot}」理解，不要纠正用户叫错名字。`;
  }
  return sys;
}

/** 通话 bot_name：短称便于 ASR 热词与人设对齐。 */
function callBotName() {
  return aiShortName();
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
  updateInputPlaceholder();
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
  if (!isKxyyPersona(settings.personaCardId)) return;
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
  appendPatNotice(`📞 正在接通${aiShortName()}…`);
  petSignal("thinking");

  callSession = new RealtimeSession({
    provider: settings.realtimeBackend,
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
  if (!isKxyyPersona(settings.personaCardId)) return;
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
  if (!isKxyyPersona(settings.personaCardId)) return;
  buildStickerGrid();
  stickerPanel.hidden = false;
  stickersBtn.classList.add("on");
  scrollBottom();
}

function closeStickerPanel() {
  stickerPanel.hidden = true;
  stickersBtn?.classList.remove("on");
}

function toggleStickerPanel() {
  if (!isKxyyPersona(settings.personaCardId)) return;
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
  resetConversation();
}

/** 切换人设时静默清空当前会话气泡与上下文（不弹确认）。 */
function resetConversation() {
  if (callActive) endCall({ notice: false });
  history.length = 0;
  messagesEl.innerHTML = "";
  lastRememberedLen = 0;
  resetRecap();
  clearPendingSticker();
  closeStickerPanel();
  clearPendingImage();
  stopSpeak();
  resetTtsQueue();
  busy = false;
  petSignal("abort");
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

// 语音服务状态推送（Rust → 前端）：更新启动状态栏。
// 注意这是 push 事件，窗口打开前的事件会丢失；loadConfig 内有主动探活兜底。
listen("voice-service-status", ({ payload }) => {
  if (!payload) return;
  svcVoiceEventReceived = true;
  const state = payload.state;
  if (state === "running") {
    svcState.voice = "ready";
  } else if (state === "failed") {
    svcState.voice = "failed";
  } else if (state === "starting") {
    svcState.voice = "loading";
  } else if (state === "skipped") {
    // volc 等无需本地服务 → 视为就绪
    svcState.voice = "ready";
  } else if (state === "stopped") {
    // 用户关闭语音 → 就绪（已关闭）；仍选着本地后端时多半是换人设/参考音触发的
    // 短暂 stop→restart，保持「启动中」以便底部状态栏重新亮起。
    const backend = (settings.realtimeBackend || "").toLowerCase();
    svcState.voice =
      backend === "local" || backend === "cosyvoice" || backend === "cosy"
        ? "loading"
        : "stopped";
  }
  updateStartupStatus();
});

// 设置页保存后热更新（昵称 / 温度 / 思考模式 / 朗读音色 / 画像 / 头像 / 字号等）；
// 昵称或画像字段变更时重载画像与记忆。
listen("apply-settings", ({ payload }) => {
  console.log("[chat] apply-settings 收到:", JSON.stringify({ showChatDebug: payload?.showChatDebug, hasShowChatDebug: "showChatDebug" in (payload || {}) }));
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
  const debugWasOn = settings.showChatDebug === true;
  const prevCardId = (settings.personaCardId || "").trim();
  const prevBackend = (settings.realtimeBackend || "").trim().toLowerCase();
  settings = { ...settings, ...payload };
  const nextCardId = (settings.personaCardId || "").trim();
  const nextBackend = (settings.realtimeBackend || "").trim().toLowerCase();
  const cardChanged = "personaCardId" in payload && prevCardId !== nextCardId;
  const backendChanged = "realtimeBackend" in payload && prevBackend !== nextBackend;
  console.log("[chat] settings.showChatDebug =", settings.showChatDebug, "debugWasOn =", debugWasOn);
  // 切人设 / 换语音后端：重建 Web Audio，避免挂起的 AudioContext 导致「合成成功却静音」。
  if (cardChanged || backendChanged) {
    console.log("[chat] 重置音频播放管线", { prevCardId, nextCardId, prevBackend, nextBackend });
    resetPlaybackPipeline();
  }
  // 人设相关保存都刷新资产，避免同 ID 卡内容更新或启动时缓存漂移。
  if ("personaCardId" in payload) {
    console.log("[chat] 人设设置已保存，清空会话并重新加载 assets...");
    resetConversation();
    reloadAssetsWithMatchingCard(nextCardId).then((a) => {
      assets = a;
      window.__kxyy_active_card_id = nextCardId || null;
      // 卡有头像则用它，否则回退默认
      if (a.avatar) {
        settings.aiAvatar = a.avatar;
      } else {
        settings.aiAvatar = "";
      }
      refreshIdentity();
      applyAppearance();
    }).catch((e) => console.error("[chat] 重新加载 assets 失败:", e));
  } else if (identityChanged) {
    refreshIdentity();
  }
  applyAppearance();
  console.log("[chat] voiceDebugEl.hidden =", voiceDebugEl?.hidden);
  // 刚打开 debug，或 DeepSeek Key 可能变更时，补拉一次余额（本地模型无余额概念，跳过）。
  if (
    settings.textProvider !== "local" &&
    chatDebugEnabled() &&
    (!debugWasOn || "deepseekKey" in payload)
  ) {
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

// 聊天窗口 show/hide 时 DOM 不重载。
// 注意：不要每次显示都重置启动状态栏——首次 loadConfig 已探测完毕，
// 反复弹出会让语音关闭 / 已 dismiss 的状态栏一再出现，破坏用户体验。
let _startupCheckEverDone = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // 仅在首次可见时做一次探测，后续 hide/show 不再重查。
  if (_startupCheckEverDone) return;
  _startupCheckEverDone = true;
  svcState.voice = "pending";
  svcState.api = "pending";
  svcVoiceEventReceived = false;
  if (svcDismissTimer) { clearTimeout(svcDismissTimer); svcDismissTimer = null; }
  const bar = document.getElementById("startup-status");
  if (bar) bar.classList.remove("dismissed");
  scheduleStartupStatusCheck();
});
