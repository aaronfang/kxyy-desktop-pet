// 实时语音通话控制器（前端）。
//
// 与本地 Rust 桥接（realtime.rs）的私有协议：
//   连上后先发 {type:"start", systemRole, botName, initialHistory?}；随后：
//     上行 binary = 麦克风 PCM16 mono 16k（worklet 产出）；
//     下行 binary = 火山/旧服务为 PCM16 mono 24k；本地/Cosy 可协商 managed-v1 envelope；
//     下行 text  = 事件 JSON：
//       {type:"session",state} / {type:"asr_start"} /
//       {type:"speech_candidate|speech_confirmed|speech_rejected"} /
//       {type:"endpoint_soft_end|endpoint_reopened|endpoint_committed",silenceMs} /
//       {type:"asr",text,interim} / {type:"asr_end"} /
//       {type:"assistant",text} / {type:"assistant_end"} / {type:"tts_start|tts_end"} /
//       {type:"reply_cancel_timeout",cancelledGeneration} /
//       {type:"thinking_filler",runtimeGenerated:true,audio:base64} /
//       {type:"audio_segment_start|audio_segment_end",segmentId,...} /
//       session/asr_end.vadShadowSummary / {type:"vad_shadow_summary",final:true,summary} /
//       {type:"speaking"} / {type:"usage",...} / {type:"error",message}。
//     managed-v1 每个 PCM chunk 自带 generation/segment/chunk identity；binary 不推进 generation。
//     本地级联控制事件可附带单调 generation；低于当前 generation 的迟到事件会被丢弃。
//     上行 text 可含 {type:"playback_segment",generation,segmentId,state:"completed"}；
//     只回执句段标识，不回传文本或 PCM。
//     本地/Cosy 清空播放时可发 {type:"playback_reset"}，清理服务端的有界尾部状态。
//     memoryContext 可协商 session-start-v1；本地/Cosy 还可协商 turn-final-v1，
//     fresh-topic-v1 先协商，服务端确认后再以 fresh_topics 消息注入启动缓存；
//     逐轮缓存仍通过 memory_context 注入；
//     服务端未明确回显时视为 none，不把 ASR final 误当作支持动态 context。
//   挂断发 {type:"hangup"}。
//
// 音频采集/播放放前端而非 Rust 的原因：getUserMedia 自带回声消除(AEC)/降噪/AGC，
// 桌宠是外放场景，没有 AEC 会自己听到自己造成啸叫与误打断。

import { getVoiceGain, onVoiceGainChange } from "./voice-volume.js";
import {
  classifyImportantTopicBranch,
  classifyReasoningSignal,
  createRecoveryTurnStrategy,
  createConversationDirector,
  createReasoningPolicyController,
  createSessionTopicLedger,
  normalizeReasoningPreference,
  relatedTopicKeys,
  sanitizeTurnStrategy,
} from "./conversation-director.js";
import {
  RealtimeTrace,
  TRACE_EVENT,
  sanitizeVadShadowSummary,
} from "./realtime-trace.js";

const invoke = window.__TAURI__.core.invoke;

const OUTPUT_RATE = 24000; // 与 realtime.rs protocol::OUTPUT_SAMPLE_RATE 一致
const TARGET_RATE = 16000; // 上行目标采样率
const MAX_PENDING_PCM_CHUNKS = 64;
const PLAYBACK_MAX_QUEUE_MS = 3000;
const PLAYBACK_DRAIN_GRACE_MS = 300;
const TRANSPORT_RECOVERY_ATTEMPTS_BEFORE_RESTART = 3;
const TRANSPORT_RECOVERY_MAX_ATTEMPTS = 6;
const TRANSPORT_RECOVERY_DELAYS_MS = [0, 250, 750, 1500, 2500, 4000];
const VOICE_SERVICE_RECOVERY_POLL_MS = 1000;
const VOICE_SERVICE_UNKNOWN_MAX_POLLS = 10;
const SESSION_HANDSHAKE_TIMEOUT_MS = 5000;
const CALL_END_REASONS = new Set([
  "app_quit",
  "backend_switch",
  "explicit_conversation_clear",
  "hangup",
  "persona_switch",
  "provider_terminal",
]);
const MAX_AUDIO_SEGMENTS = 64;
const MANAGED_AUDIO_CAPABILITY = "managed-v1";
const MANAGED_AUDIO_MAGIC = 0x4b584155; // ASCII KXAU; not a Volcano protocol constant.
const MANAGED_AUDIO_VERSION = 1;
const MANAGED_AUDIO_HEADER_BYTES = 24;
const MANAGED_AUDIO_CHUNK_MAX_SAMPLES = (OUTPUT_RATE * 80) / 1000;
const MANAGED_AUDIO_CHUNKS_PER_SEGMENT_MAX = 750;
const MANAGED_AUDIO_SEGMENT_MAX_SAMPLES = OUTPUT_RATE * 60;
const TTS_STREAMING_CAPABILITY = "provider-pcm-v1";
const RESPONSE_FINISH_CAPABILITY = "response-finish-v1";
const RESPONSE_FINISH_WATCHDOG_MS = 12000;
// Local managed PCM is paced at the source clock. A 200ms reservoir keeps a
// short scheduling cushion while shaving a measurable part of first playback;
// unnegotiated/legacy paths remain unchanged.
const STREAMING_PLAYBACK_STARTUP_MS = 200;
const INTERRUPTION_HINT_CAPABILITY = "candidate-snapshot-v1";
const RESPONSE_OUTPUT_TYPES = new Set([
  "assistant",
  "assistant_end",
  "thinking_filler",
  "tts_start",
  "tts_end",
  "audio_segment_start",
  "audio_segment_end",
  "speaking",
  "error",
]);
const INTERRUPTION_RECOVERY_CAPABILITY = "empty-confirmed-v1";
const INTERRUPTION_RECOVERY_GRACE_MS = 4500;
const INTERRUPTION_RECOVERY_DEFER_MS = 250;
const SESSION_MEMORY_CAPABILITY = "session-start-v1";
const TURN_MEMORY_CAPABILITY = "turn-final-v1";
const TEMPORAL_CONTEXT_CAPABILITY = "turn-local-v1";
const FRESH_TOPIC_CAPABILITY = "fresh-topic-v1";
const PENDING_TURN_RESUME_CAPABILITY = "pending-turn-resume-v1";
const PROACTIVE_TURN_CAPABILITY = "local-v1";
const MAX_TURN_MEMORY_ITEMS = 3;
const MAX_TURN_MEMORY_CHARS = 700;
const MAX_FRESH_TOPIC_ITEMS = 3;
const MAX_FRESH_TOPIC_CHARS = 1200;
const MAX_INITIAL_HISTORY_MESSAGES = 12;
const MAX_INITIAL_HISTORY_MESSAGE_CHARS = 1024;
const MAX_INITIAL_HISTORY_CHARS = 4096;
const CANDIDATE_ID_MAX = 0xffffffff;
const CANDIDATE_SNAPSHOT_GRACE_MS = 50;
const VAD_SHADOW_FINAL_WAIT_MS = 50;
const MAX_TOPIC_KEY_CHARS = 64;
const MAX_TOPICS_USED = 8;
const PROACTIVE_KINDS = new Set(["welcome", "followup", "idle", "revisit", "memory", "commitment"]);
const OPENING_STYLES = Object.freeze([
  "warm-direct",
  "context-first",
  "playful",
  "topic-first",
]);
let openingStyleCursor = Math.floor(Math.random() * OPENING_STYLES.length);

function nextOpeningStyle() {
  const style = OPENING_STYLES[openingStyleCursor % OPENING_STYLES.length];
  openingStyleCursor = (openingStyleCursor + 1) % OPENING_STYLES.length;
  return style;
}

const PAUSE_TURN_RE = /^(?:安静(?:一会儿|一下|会儿)?|先别说(?:话)?|不要说(?:话)?|暂停(?:一下)?|停一下|先停一下|让我想想|让我静静|我想静静|等一下|稍等(?:一下)?|你先听我说|先听我说|让我先(?:说|讲)(?:完)?|等我(?:说|讲)完|先不跟你聊(?:了|啦)?(?:[，,、\s]+我先吃了?(?:啊|呀)?)?|不跟你聊(?:了|啦)?|先吃饭(?:了|啦)?|我先(?:去)?吃饭(?:了|啦)?|我先忙(?:一会儿|一下)?|回头再聊)$/;
const REDIRECT_TURN_RE = /(?:换个?话题|换一个话题|聊点别的|聊别的|别聊这个|不聊这个|说点别的|跳过这个|不说这个)/;
const FAST_SOCIAL_TURN_RE = /^(?:你好|嗨|哈喽|早上好|早安|晚上好|晚安|拜拜|再见|回头聊|下次聊)[啊呀哈啦～~！!。.]*$/;
const CALL_OPENING_RE = /^(?:喂[，,、\s]*)?(?:在吗|能听见吗|听得见吗|能听到吗|听得到吗|听见了吗|听到了吗)[啊呀呢嘛～~！!？?。.]*$/;
const REASONING_ANAPHORA_RE = /(?:这件事|这个|这点|刚才|前面|还有|确实|顾虑|慢慢(?:看|想)|先看看|那(?:个|件|种)?)/;
const RESUME_TURN_RE = /^(?:继续(?:说|讲|聊)?(?:吧)?|你继续(?:说|讲|聊)?(?:吧)?|接着(?:说|讲|聊)?(?:吧)?|你说吧|可以继续了|好了继续)$/;
const ACKNOWLEDGE_TURN_RE = /^(?:嗯+|嗯呐|嗯哪|哦+|啊+|好+|好的|行+|明白了?|知道了|原来如此|收到)$/;
const AMUSED_TURN_RE = /^(?:哈{2,}|嘿{2,}|呵{2,}|笑死(?:我了)?|太逗了|有意思|真好笑)$/;
const CURIOUS_TURN_RE = /^(?:是吗|真的(?:啊|吗)?|然后呢|后来呢|还有呢|怎么说|为什么(?:呀|啊)?)$/;
const AGREE_TURN_RE = /^(?:对+|对啊|是的|没错|确实|可不是|我也觉得|有道理|听你的(?:听你的)*|那?没毛病|行(?:啊|呀|吧)?行?)$/;
const LATERAL_SHIFT_VETO_RE = /生产|数据库|报错|故障|崩溃|紧急|修复|排查|事故|报警|求救|自杀|想死|伤害自己|去世|住院|诊断|用药|发烧|拉肚子|腹泻|疼醒|肚子疼|头晕|晕晕乎乎|喘不上气|胸痛|转账|诈骗|律师|法律|欠债|焦虑|恐慌|害怕|委屈|失落|痛苦/i;
const ENGAGEMENT_POLICIES = new Set(["acknowledge", "amused", "curious", "agree"]);
const INVITE_ADVICE_RE = /你觉得我?(?:该|应该)?怎么办|我(?:该|应该)怎么办|换成你(?:会)?怎么做|你会怎么做|给我.{0,12}(?:建议|主意)/;
const INVITE_OPINION_RE = /你(?:是)?怎么(?:看|想)(?:的)?|你有(?:什么|啥)看法|想听听你(?:是)?怎么(?:想|看)|换成你(?:会)?怎么(?:想|看待)/;
const DEEPEN_RE = /深入(?:点|一点)?.{0,6}(?:聊|说|讲)|聊深(?:点|一点)|多(?:说|讲|聊)(?:点|一点|一些)|展开(?:说|讲|聊)|详细(?:说|讲|聊)/;
const LIGHTEN_RE = /轻松(?:点|一点)|别(?:聊|说)得?这么沉重|聊点轻松的/;
const CONCRETIZE_RE = /(?:说|讲)具体(?:点|一点)|举个例子|比如呢|说清楚(?:点|一点)?/;
const HANDOFF_RE = /(?:不知道(?:聊|说|干|做)什么|不知道(?:该)?干嘛|没啥安排|没什么安排|你(?:来|说|讲|推荐|挑|选)(?:一个|几个|点|点儿|点什么|吧)|给我推荐(?:一个|几个|点|点儿)|随便聊(?:点|点儿|什么)?|聊什么都行|你.{0,6}(?:有啥|有什么)新鲜事)/;
const SETTLING_TOPIC_RE = /就是这个道理|反正|总归|就这样|先这样|不说这个|先不说|准备(?:准备)?(?:去|开播|开始)|那就(?:这么|这样)|行了行了|大不了/;
const ACTIVE_TOPIC_RE = /[?？]|为什么|怎么(?:办|样|说)|会不会|能不能|要不要|该不该|如果|万一|紧张|担心|拿不准|没底|不知道/;

/** Fixed, local-only policy. It never asks a model to decide whether proactive speech is allowed. */
export function classifyRealtimeConversationTurn(text) {
  const value = String(text || "").trim();
  if (!value) return "silence";
  const compact = value.replace(/[。！!？?，,\s]+$/gu, "");
  if (PAUSE_TURN_RE.test(compact)) return "pause";
  if (REDIRECT_TURN_RE.test(compact)) return "redirect";
  if (RESUME_TURN_RE.test(compact)) return "resume";
  if (ACKNOWLEDGE_TURN_RE.test(compact)) return "acknowledge";
  if (AMUSED_TURN_RE.test(compact)) return "amused";
  if (CURIOUS_TURN_RE.test(compact)) return "curious";
  if (AGREE_TURN_RE.test(compact)) return "agree";
  return "substantive";
}

/** Per-turn guidance only. It never mutates pause/redirect/resume state. */
export function classifyRealtimeSoftIntent(text) {
  const value = String(text || "").trim();
  if (!value || classifyRealtimeConversationTurn(value) !== "substantive") return "none";
  if (HANDOFF_RE.test(value)) return "handoff";
  if (INVITE_ADVICE_RE.test(value)) return "invite-advice";
  if (INVITE_OPINION_RE.test(value)) return "invite-opinion";
  if (DEEPEN_RE.test(value)) return "deepen";
  if (LIGHTEN_RE.test(value)) return "lighten";
  if (CONCRETIZE_RE.test(value)) return "concretize";
  return "none";
}

export function classifyRealtimeTopicActivity(text, policy = "substantive", lateralAllowed = true) {
  const value = String(text || "").trim();
  if (!lateralAllowed) return "sensitive";
  if (["acknowledge", "agree"].includes(policy) || SETTLING_TOPIC_RE.test(value)) {
    return "settling";
  }
  if (ACTIVE_TOPIC_RE.test(value)) return "active";
  return "neutral";
}

export function classifyRealtimeConversationDepth(text, softIntent = "none", topicActivity = "neutral") {
  if (softIntent === "lighten") return 0;
  if (softIntent === "deepen") return 2;
  const importantBranch = classifyImportantTopicBranch(text);
  if (["decision", "relationship", "long-running"].includes(importantBranch)) return 2;
  if (importantBranch === "emotion" || importantBranch === "goal" || topicActivity === "sensitive") {
    return 1;
  }
  return 0;
}

export function classifyRealtimeReasoningSignal(text, softIntent = "none") {
  return classifyReasoningSignal(text, { explicitDepth: softIntent === "deepen" });
}

export function isRealtimeLateralShiftSafe(text) {
  const value = String(text || "").trim();
  return Boolean(value) && !LATERAL_SHIFT_VETO_RE.test(value);
}

function sanitizeFreshTopics(items) {
  const safe = [];
  let chars = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (safe.length >= MAX_FRESH_TOPIC_ITEMS) break;
    const title = typeof item?.title === "string" ? item.title.trim().slice(0, 120) : "";
    const shortText = typeof item?.shortText === "string" ? item.shortText.trim().slice(0, 300) : "";
    const sourceName = typeof item?.sourceName === "string" ? item.sourceName.trim().slice(0, 64) : "";
    const canonicalUrl = typeof item?.canonicalUrl === "string" && /^https:\/\//i.test(item.canonicalUrl)
      ? item.canonicalUrl.slice(0, 512)
      : "";
    const fetchedAt = typeof item?.fetchedAt === "string" ? item.fetchedAt.slice(0, 40) : "";
    const publishedAt = typeof item?.publishedAt === "string" ? item.publishedAt.slice(0, 40) : "";
    const category = typeof item?.category === "string" ? item.category.slice(0, 32) : "";
    if (!title || !shortText || !sourceName || !canonicalUrl || !fetchedAt || !category) continue;
    if (chars + shortText.length > MAX_FRESH_TOPIC_CHARS) continue;
    safe.push({
      sourceName,
      canonicalUrl,
      title,
      publishedAt: publishedAt || null,
      fetchedAt,
      shortText,
      category,
    });
    chars += shortText.length;
  }
  return safe;
}

/** Session-only topic identity. It is never sent over the wire or exposed in diagnostics. */
export function deriveRealtimeTopicKey(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/（[^（）]*）|\([^()]*\)|【[^【】]*】|\*[^*]+\*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const chars = Array.from(normalized).slice(0, MAX_TOPIC_KEY_CHARS);
  return chars.length >= 2 ? chars.join("") : "";
}

function usesManagedCascade(provider) {
  return provider === "local" || provider === "voxcpm" || provider === "cosyvoice";
}

/** Bounded local/Cosy-only bridge from visible text chat into a new voice session. */
export function sanitizeRealtimeInitialHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const volatileFact = [...messages].reverse().find((message) => {
    if (message?.role !== "user") return false;
    const content = String(message.content || "").replace(/\s+/g, "");
    if (!content || /[？?]$/.test(content)) return false;
    const hasToday = /今天|今晚|今儿/.test(content);
    const hasRole = /你|元元|圆圆|原原|源源|园园/.test(content);
    const hasLiveState = /不直播|不播|没直播|没播|开播|会直播|要直播|还得直播|准备直播|打算直播/.test(
      content,
    );
    return hasToday && hasRole && hasLiveState;
  });
  const selected = [];
  let totalChars = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    let content = typeof message?.content === "string" ? message.content.trim() : "";
    if (!content || content.startsWith("\u2063")) continue;
    content = Array.from(content).slice(0, MAX_INITIAL_HISTORY_MESSAGE_CHARS).join("");
    if (!content || totalChars + content.length > MAX_INITIAL_HISTORY_CHARS) continue;
    selected.push({ role, content, index });
    totalChars += content.length;
    if (selected.length >= MAX_INITIAL_HISTORY_MESSAGES) break;
  }
  const volatileIndex = volatileFact ? messages.indexOf(volatileFact) : -1;
  if (volatileIndex >= 0 && !selected.some((message) => message.index === volatileIndex)) {
    const content = Array.from(String(volatileFact.content || "").trim())
      .slice(0, MAX_INITIAL_HISTORY_MESSAGE_CHARS)
      .join("");
    while (
      selected.length &&
      (selected.length >= MAX_INITIAL_HISTORY_MESSAGES ||
        totalChars + content.length > MAX_INITIAL_HISTORY_CHARS)
    ) {
      totalChars -= selected.pop().content.length;
    }
    if (content && totalChars + content.length <= MAX_INITIAL_HISTORY_CHARS) {
      selected.push({ role: "user", content, index: volatileIndex });
    }
  }
  selected.sort((left, right) => left.index - right.index);
  while (selected[0]?.role === "assistant") selected.shift();
  const normalized = [];
  for (const message of selected) {
    const previous = normalized.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      previous.content = Array.from(`${previous.content}\n${message.content}`)
        .slice(0, MAX_INITIAL_HISTORY_MESSAGE_CHARS)
        .join("");
    } else {
      normalized.push({ role: message.role, content: message.content });
    }
  }
  return normalized;
}

function sanitizeAsrRuntime(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    requested: ["whisper", "sensevoice"].includes(raw.requested)
      ? raw.requested
      : "whisper",
    active: ["whisper-mlx", "whisper-openai", "sensevoice-sherpa-onnx", "none"].includes(
      raw.active,
    )
      ? raw.active
      : "none",
    status: ["active", "fallback", "unavailable"].includes(raw.status)
      ? raw.status
      : "not-reported",
  };
}

function decodeThinkingFiller(value) {
  if (typeof value !== "string" || value.length > 160000 || typeof atob !== "function") return null;
  try {
    const decoded = atob(value);
    if (!decoded || decoded.length < 2 || decoded.length % 2) return null;
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function recoverablePlaybackEnabled() {
  try {
    return globalThis.localStorage?.getItem("kxyy.realtime.playback") !== "legacy";
  } catch {
    return true;
  }
}

export function decodeManagedAudioFrame(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < MANAGED_AUDIO_HEADER_BYTES + 2) {
    return null;
  }
  const view = new DataView(data);
  const magic = view.getUint32(0, false);
  const version = view.getUint8(4);
  const flags = view.getUint8(5);
  const headerBytes = view.getUint16(6, false);
  const generation = view.getUint32(8, false);
  const segmentId = view.getUint32(12, false);
  const chunkSequence = view.getUint32(16, false);
  const payloadSamples = view.getUint32(20, false);
  if (
    magic !== MANAGED_AUDIO_MAGIC ||
    version !== MANAGED_AUDIO_VERSION ||
    flags !== 0 ||
    headerBytes !== MANAGED_AUDIO_HEADER_BYTES ||
    segmentId < 1 ||
    chunkSequence >= MANAGED_AUDIO_CHUNKS_PER_SEGMENT_MAX ||
    payloadSamples < 1 ||
    payloadSamples > MANAGED_AUDIO_CHUNK_MAX_SAMPLES ||
    data.byteLength !== headerBytes + payloadSamples * 2
  ) {
    return null;
  }
  return {
    generation,
    segmentId,
    chunkSequence,
    payloadSamples,
    pcm: data.slice(headerBytes),
  };
}

/** 通话会话：封装 WS、麦克风采集、可恢复 Worklet 播放与两阶段打断。 */
export class RealtimeSession {
  constructor({
    onState,
    onAsrStart,
    onAsr,
    onAsrEnd,
    onAssistant,
    onAssistantEnd,
    onAssistantDiscarded,
    onAudibleAssistant,
    onAudibleResponseComplete,
    onThinking,
    onSpeaking,
    onUsage,
    onLevel,
    onSpeechCandidate,
    onSpeechRejected,
    onMemoryContextRequest,
    onThinkingFillerOffer,
    onPlaybackStats,
    onResponseError,
    getRecoveryHistory,
    onTransportReset,
    onError,
    provider = "unknown",
    conversationMode = "follow-user",
    reasoningPreference = "off",
    proactiveGreetingDelayMs,
    proactiveFollowupDelayMs,
    proactiveIdleDelayMs,
    interruptionRecoveryGraceMs,
    interruptionRecoveryDeferMs,
    responseFinishWatchdogMs,
    thinkingFeedbackDelayMs,
    maxTraceEvents = 256,
    onTrace,
  } = {}) {
    this.cb = {
      onState,
      onAsrStart,
      onAsr,
      onAsrEnd,
      onAssistant,
      onAssistantEnd,
      onAssistantDiscarded,
      onAudibleAssistant,
      onAudibleResponseComplete,
      onThinking,
      onSpeaking,
      onUsage,
      onLevel,
      onSpeechCandidate,
      onSpeechRejected,
      onMemoryContextRequest,
      onThinkingFillerOffer,
      onPlaybackStats,
      onResponseError,
      getRecoveryHistory,
      onTransportReset,
      onError,
    };
    this.ws = null;
    this.micStream = null;
    this.audioCtx = null; // 采集+播放共用一个 AudioContext（WKWebView 解锁关键）
    this.workletNode = null;
    this.micSource = null;
    this.playHead = 0; // 下行播放调度游标
    this.stopped = false;
    this._micLevel = 0;
    this._playLevel = 0;
    this._micWave = new Float32Array(48);
    this._playWave = new Float32Array(48);
    this._levelRaf = 0;
    this._pendingPcm = []; // context 未 running 时暂存下行 PCM，避免排进「过去」
    this._resumingOut = false;
    this._bargeInTurn = false; // 本轮用户说话是否已打断过播报
    this._userTurnOpen = false; // asr_start…asr_end 之间为 true
    this._assistantActive = false; // 助手正在出字/出声
    this._assistantDraftGeneration = null;
    this._backendAudioPending = false; // 本地逐句 TTS 尚可能继续产出 PCM
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._outGain = null; // 下行播放主音量
    this._unsubVol = null;
    this._micPrepare = null; // 在用户手势栈内发起的 getUserMedia Promise
    this.playbackNode = null;
    this._playbackMode = "none";
    this._playbackQueuedMs = 0;
    this._audioGate = false;
    this._speechCandidate = false;
    this._candidateInterruptsResponse = false;
    this._playbackDrainTimer = 0;
    this._responseFinishTimer = 0;
    this._responseFinishGeneration = null;
    this._responseFinishRecoveryPending = false;
    this.trace = new RealtimeTrace({ provider, maxEvents: maxTraceEvents, onEvent: onTrace });
    this._backendGeneration = 0;
    this._interruptedResponseGeneration = null;
    this._lastDurableAudibleGeneration = null;
    this._traceAsrFinalSeen = false;
    this._currentAudioSegment = null;
    this._audioSegments = new Map();
    this._legacySegments = new Map();
    this._downlinkAudioMode = "raw";
    this._ttsStreamingMode = "none";
    this._interruptionHintMode = "none";
    this._interruptionRecoveryMode = "none";
    this._responseFinishMode = "none";
    this._responseFinishWatchdogMs = Number.isFinite(responseFinishWatchdogMs)
      ? Math.max(0, responseFinishWatchdogMs)
      : RESPONSE_FINISH_WATCHDOG_MS;
    this._memoryContextMode = "none";
    this._temporalContextMode = "none";
    this._freshTopicMode = "none";
    this._startupFreshTopics = [];
    this._memoryContextRequestedAt = 0;
    this._pendingMemoryContextReason = "turn";
    this._vadShadowMode = "disabled";
    this._asrRuntime = sanitizeAsrRuntime();
    this._vadShadowSummary = sanitizeVadShadowSummary();
    this._resolveVadShadowFinal = null;
    this._candidateId = null;
    this._candidateSnapshot = null;
    this._candidateSegmentKeys = null;
    this._pendingConfirmedCandidate = null;
    this._candidateSnapshotTimer = 0;
    this._confirmedInterruptionEligible = false;
    this._interruptionRecoveryTimer = 0;
    this._interruptionRecoveryRequestId = 0;
    this._pendingInterruptionRecovery = null;
    this._interruptionRecoveryGraceMs = Number.isFinite(interruptionRecoveryGraceMs)
      ? Math.max(0, interruptionRecoveryGraceMs)
      : INTERRUPTION_RECOVERY_GRACE_MS;
    this._interruptionRecoveryDeferMs = Number.isFinite(interruptionRecoveryDeferMs)
      ? Math.max(0, interruptionRecoveryDeferMs)
      : INTERRUPTION_RECOVERY_DEFER_MS;
    this._interruptionRecoverySummary = {
      scheduled: 0,
      started: 0,
      cancelled: 0,
      completed: 0,
      finishStalls: 0,
      finishRecoveries: 0,
    };
    this._turnStrategySummary = {
      moves: { respond: 0, expand: 0, deepen: 0, associate: 0, recover: 0 },
      stances: { support: 0, opine: 0, contrast: 0, lead: 0 },
      reasoningPolicies: { fast: 0, deliberate: 0 },
      responseCues: { none: 0, lowBurden: 0, question: 0 },
      depths: { zero: 0, one: 0, two: 0, three: 0 },
      sources: {
        preferenceOff: 0,
        preferenceAlways: 0,
        automaticSignal: 0,
        automaticCarry: 0,
        automaticFast: 0,
        fastControl: 0,
      },
    };
    this._conversationMode = ["balanced", "ai-leads"].includes(conversationMode)
      ? conversationMode
      : "follow-user";
    this._reasoningPreference = normalizeReasoningPreference(reasoningPreference);
    this._reasoningController = createReasoningPolicyController({
      preference: this._reasoningPreference,
    });
    this._pendingReasoningDecision = this._reasoningController.select({
      turnCategory: "substantive",
      signal: "none",
    });
    this._reasoningTopicKey = "";
    this._reasoningPolicyGenerations = new Set();
    this._proactiveTurnMode = "none";
    this._proactiveTriggerId = 0;
    this._proactiveWelcomeSent = false;
    this._proactiveGreetingTimer = 0;
    this._proactiveLeadTimer = 0;
    this._missedProactiveWindowPending = false;
    this._proactivePending = new Map();
    this._activeProactiveTriggerId = null;
    this._activeProactiveGeneration = null;
    this._activeProactiveFirstAudioAt = 0;
    this._pendingProactiveRhythmSignal = null;
    this._latestFinalAsr = "";
    this._lastAudibleGeneration = null;
    this._topicLead = {
      phase: "opening",
      aiTurnsOnTopic: 0,
      consecutiveShortReplies: 0,
      userEngagement: "none",
      proactiveTurns: 0,
      topicSwitches: 0,
      paused: false,
      lastProactiveKind: "none",
      topicKey: "",
      topicsUsed: [],
      repeatedTopic: false,
    };
    this._sessionTopicLedger = this._conversationMode === "ai-leads"
      ? createSessionTopicLedger()
      : null;
    this._activeImportantTopicKey = "";
    this._proactiveTopicProposals = new Map();
    this._proactiveRhythm = {
      delayMultiplier: 1,
      negativeSignals: 0,
      stopped: false,
      lastNegativeTriggerId: null,
    };
    this._proactiveSummary = {
      candidates: 0,
      accepted: 0,
      vetoed: 0,
      cancelled: 0,
      preAudioUserReclaims: 0,
      earlyPlaybackInterruptions: 0,
      proactiveTurns: 0,
      topicSwitches: 0,
      replyCancelTimeouts: 0,
      conversationMoves: { respond: 0, expand: 0, deepen: 0, associate: 0, recover: 0 },
      topicActivity: { active: 0, neutral: 0, settling: 0, sensitive: 0 },
      triggerKinds: { welcome: 0, followup: 0, idle: 0, memory: 0, commitment: 0 },
      engagementCategories: {
        acknowledge: 0,
        amused: 0,
        curious: 0,
        agree: 0,
        pause: 0,
        redirect: 0,
        resume: 0,
        substantive: 0,
        silence: 0,
      },
      vetoReasons: {
        speech: 0,
        asr: 0,
        reply: 0,
        playback: 0,
        receipt: 0,
        cooldown: 0,
        limit: 0,
      },
      rhythmBackoffs: 0,
      rhythmStops: 0,
    };
    this._sessionStarted = false;
    this._openingStyle = nextOpeningStyle();
    this._openingStyleGeneration = null;
    this._userFinalTurns = 0;
    this._startMessage = null;
    this._recoveryInFlight = false;
    this._recoveryAttempt = 0;
    this._transportRecovering = false;
    this._pendingUserTurn = false;
    this._pendingTurnResumeMode = "none";
    this._micReady = false;
    this._proactiveGreetingDelayMs = Number.isFinite(proactiveGreetingDelayMs)
      ? Math.max(0, proactiveGreetingDelayMs)
      : this._conversationMode === "ai-leads"
        ? 600
        : 1200;
    this._proactiveFollowupDelayMs = Number.isFinite(proactiveFollowupDelayMs)
      ? Math.max(0, proactiveFollowupDelayMs)
      : this._conversationMode === "ai-leads"
        ? 4500
        : 10000;
    this._proactiveIdleDelayMs = Number.isFinite(proactiveIdleDelayMs)
      ? Math.max(0, proactiveIdleDelayMs)
      : this._conversationMode === "ai-leads"
        ? 14000
        : 32000;
    this._conversationDirector = this._conversationMode === "ai-leads"
      ? createConversationDirector({
          mode: "ai-leads",
          delays: {
            statement: Number.isFinite(proactiveFollowupDelayMs)
              ? this._proactiveFollowupDelayMs
              : 4000,
            lowBurden: Number.isFinite(proactiveFollowupDelayMs)
              ? this._proactiveFollowupDelayMs
              : 6000,
            question: Number.isFinite(proactiveFollowupDelayMs)
              ? this._proactiveFollowupDelayMs
              : 8000,
            topicSwitch: this._proactiveIdleDelayMs,
          },
        })
      : null;
    this._conversationDirector?.dispatch({ type: "session-started" });
    this._pendingTurnStrategy = null;
    this._pendingTurnStrategyGeneration = null;
    this._turnStrategies = new Map();
    this._proactiveTurnStrategies = new Map();
    this._thinkingFeedbackDelayMs = Number.isFinite(thinkingFeedbackDelayMs)
      ? Math.max(0, thinkingFeedbackDelayMs)
      : 1500;
    this._thinkingFeedbackTimer = 0;
    this._thinkingFillerOffered = false;
    this._thinkingPhase = "idle";
  }

  /**
   * 必须在电话按钮点击的同步栈内调用（任何 await 之前）。
   * 创建 AudioContext、播一帧静音、拉起 keep-alive，否则 WKWebView 首包 TTS 会静音。
   */
  prepareAudio() {
    this._initAudioCtx();
    // 必须在用户点击的同步栈内发起 getUserMedia；打包版 WKWebView 在 await 之后再调
    // 可能拿不到合法 MediaStream（createMediaStreamSource 报类型错误）。
    if (!this._micPrepare) this._micPrepare = this._acquireMicStream();
  }

  _acquireMicStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error("当前环境不支持麦克风采集"));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  }

  /** 开始通话：确认播放能力 → 连桥接并协商 → 起麦克风。 */
  async start({ systemRole, botName, initialHistory, freshTopics }) {
    this._startMessage = { systemRole, botName, initialHistory, freshTopics };
    this.trace.startSession();
    // 若 chat.js 已在点击栈调用 prepareAudio，这里是幂等补齐。
    this._initAudioCtx();
    if (!this._micPrepare) this._micPrepare = this._acquireMicStream();

    const base = await this._getRealtimeBase();
    if (this.stopped) return;
    if (!base) throw new Error("实时语音服务未启动");

    await this._resumeAudioCtx();
    if (this.stopped) return;
    await this._startPlayback();
    if (this.stopped) return;
    await this._openSocket(base, { systemRole, botName, initialHistory, freshTopics });
    if (this.stopped) return;
    await this._startMic();
    if (this.stopped) return;
    // 麦克风授权弹窗可能再次把 context 挂起，授权回来后再 resume 一次。
    await this._resumeAudioCtx();
    this._startLevelLoop();
  }

  _openSocket(base, startMsg) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(base);
      } catch (e) {
        reject(e);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this._sessionStarted = false;
      this._startupFreshTopics = usesManagedCascade(this.trace.provider)
        ? sanitizeFreshTopics(startMsg.freshTopics)
        : [];
      let opened = false;
      let settled = false;
      let handshakeTimer = 0;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = 0;
        if (error) reject(error);
        else resolve();
      };

      ws.onopen = () => {
        opened = true;
        const cascadeCapabilities = usesManagedCascade(this.trace.provider)
          ? { downlinkAudio: [MANAGED_AUDIO_CAPABILITY] }
          : {};
        // 明确声明当前只支持会话开始时注入记忆；动态逐轮 context 必须由后端
        // 显式回显新能力后才能启用，不能因为收到 ASR final 就默认支持。
        cascadeCapabilities.memoryContext = usesManagedCascade(this.trace.provider)
          ? [SESSION_MEMORY_CAPABILITY, TURN_MEMORY_CAPABILITY]
          : [SESSION_MEMORY_CAPABILITY];
        if (usesManagedCascade(this.trace.provider)) {
          cascadeCapabilities.temporalContext = [TEMPORAL_CONTEXT_CAPABILITY];
          cascadeCapabilities.initialHistory = sanitizeRealtimeInitialHistory(
            startMsg.initialHistory,
          );
          cascadeCapabilities.freshTopic = [FRESH_TOPIC_CAPABILITY];
          cascadeCapabilities.pendingTurnResume = [PENDING_TURN_RESUME_CAPABILITY];
          cascadeCapabilities.interruptionRecovery = [INTERRUPTION_RECOVERY_CAPABILITY];
          cascadeCapabilities.responseFinish = [RESPONSE_FINISH_CAPABILITY];
        }
        if (
          usesManagedCascade(this.trace.provider) &&
          this._conversationMode !== "follow-user"
        ) {
          cascadeCapabilities.proactiveTurn = [PROACTIVE_TURN_CAPABILITY];
        }
        if (
          usesManagedCascade(this.trace.provider) &&
          this._playbackMode === "worklet" &&
          this.playbackNode
        ) {
          cascadeCapabilities.interruptionHint = [INTERRUPTION_HINT_CAPABILITY];
          cascadeCapabilities.ttsStream = [TTS_STREAMING_CAPABILITY];
        }
        const startPayload = {
          type: "start",
          systemRole: startMsg.systemRole || "",
          botName: startMsg.botName || "元元",
          ...(usesManagedCascade(this.trace.provider)
            ? { reasoningPreference: this._reasoningPreference }
            : {}),
          ...cascadeCapabilities,
        };
        ws.send(JSON.stringify(startPayload));
        handshakeTimer = setTimeout(() => {
          if (this.ws === ws) this.ws = null;
          settle(new Error("实时语音会话握手超时"));
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }, this._sessionHandshakeTimeoutMs());
      };
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        this._onMessage(ev);
        if (this._sessionStarted) settle();
      };
      ws.onerror = () => {
        if (!settled) {
          if (this.ws === ws) this.ws = null;
          settle(new Error("连接实时语音服务失败"));
        }
      };
      ws.onclose = () => {
        if (this.ws !== ws || this.stopped) return;
        if (!settled) {
          this.ws = null;
          settle(new Error(opened ? "实时语音会话未就绪" : "连接实时语音服务失败"));
          return;
        }
        if (usesManagedCascade(this.trace.provider)) {
          void this._recoverTransport();
          return;
        }
        this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, {
          reason: "provider_terminal",
        });
        this.cb.onState?.("ended");
      };
    });
  }

  _sessionHandshakeTimeoutMs() {
    return SESSION_HANDSHAKE_TIMEOUT_MS;
  }

  async _retryRecoveredSocket(startAttempt, endAttempt) {
    for (
      this._recoveryAttempt = startAttempt;
      this._recoveryAttempt < endAttempt;
      this._recoveryAttempt += 1
    ) {
      const delay = this._transportRecoveryDelayMs(this._recoveryAttempt);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.stopped) return false;
      try {
        await this._reopenRecoveredSocket();
        this._recoveryAttempt = 0;
        this._transportRecovering = false;
        return true;
      } catch {
        // The bounded caller decides whether to restart or end the call.
      }
    }
    return false;
  }

  async _recoverTransport({ restartImmediately = false } = {}) {
    if (this._recoveryInFlight || this.stopped) return;
    this._recoveryInFlight = true;
    this._transportRecovering = true;
    this.cb.onState?.("recovering");
    this._prepareTransportRecovery();
    try {
      try {
        if (
          !restartImmediately &&
          (await this._retryRecoveredSocket(
            0,
            TRANSPORT_RECOVERY_ATTEMPTS_BEFORE_RESTART,
          ))
        )
          return;
        if (this.stopped) return;
        if (this.trace.provider === "voxcpm") {
          await this._requestVoiceServiceRecovery();
          await this._waitForVoiceServiceReady();
        }
        if (
          await this._retryRecoveredSocket(
            TRANSPORT_RECOVERY_ATTEMPTS_BEFORE_RESTART,
            TRANSPORT_RECOVERY_MAX_ATTEMPTS,
          )
        )
          return;
      } catch {
        // Terminal service failures use the same bounded end-of-call path below.
      }
      if (!this.stopped) {
        this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, {
          reason: "recovery_failed",
        });
        this.cb.onState?.("ended");
      }
    } finally {
      this._recoveryInFlight = false;
      if (this.stopped) this._transportRecovering = false;
    }
  }

  async _reopenRecoveredSocket() {
    const base = await this._getRealtimeBase();
    const recoveryHistory =
      this.cb.getRecoveryHistory?.() || this._startMessage?.initialHistory || [];
    const startMsg = {
      ...(this._startMessage || {}),
      initialHistory: recoveryHistory,
    };
    const sanitizedHistory = sanitizeRealtimeInitialHistory(recoveryHistory);
    const shouldResumePendingTurn =
      this._pendingUserTurn && sanitizedHistory.at(-1)?.role === "user";
    await this._openSocket(base, startMsg);
    if (
      shouldResumePendingTurn &&
      this._pendingTurnResumeMode === PENDING_TURN_RESUME_CAPABILITY &&
      this.ws?.readyState === WebSocket.OPEN &&
      this._sessionStarted
    ) {
      const reasoningPolicy = ["fast", "deliberate"].includes(
        this._pendingReasoningDecision?.policy,
      ) ? this._pendingReasoningDecision.policy : "fast";
      this.ws.send(JSON.stringify({ type: "resume_pending_turn", reasoningPolicy }));
      this._noteReasoningPolicy(reasoningPolicy);
      this._noteReasoningSource(this._pendingReasoningDecision?.source);
    }
  }

  async _waitForVoiceServiceReady() {
    let unknownPolls = 0;
    while (!this.stopped) {
      const status = await this._checkVoiceService();
      const state = String(status?.state || "unknown");
      if (state === "running") return;
      if (state === "failed" || state === "stopped") {
        throw new Error("本地语音服务恢复失败");
      }
      if (state === "unknown") {
        unknownPolls += 1;
        if (unknownPolls >= VOICE_SERVICE_UNKNOWN_MAX_POLLS) {
          throw new Error("无法确认本地语音服务恢复状态");
        }
      } else {
        unknownPolls = 0;
      }
      const delay = this._voiceServiceRecoveryPollDelayMs();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error("通话已结束");
  }

  _transportRecoveryDelayMs(attempt) {
    return TRANSPORT_RECOVERY_DELAYS_MS[attempt] ?? TRANSPORT_RECOVERY_DELAYS_MS.at(-1);
  }

  _getRealtimeBase() {
    return invoke("get_realtime_base");
  }

  _requestVoiceServiceRecovery() {
    return invoke("recover_voice_service");
  }

  _checkVoiceService() {
    return invoke("check_voice_service");
  }

  _voiceServiceRecoveryPollDelayMs() {
    return VOICE_SERVICE_RECOVERY_POLL_MS;
  }

  _prepareTransportRecovery() {
    this._cancelInterruptionRecovery();
    this._clearResponseFinishWatchdog();
    const staleSocket = this.ws;
    this.ws = null;
    try {
      staleSocket?.close();
    } catch {
      /* ignore */
    }
    if (Number.isSafeInteger(this._assistantDraftGeneration)) {
      this.cb.onAssistantDiscarded?.({
        generation: this._assistantDraftGeneration,
        preserveAudible: this._lastAudibleGeneration === this._assistantDraftGeneration,
      });
      this._assistantDraftGeneration = null;
    }
    this._sessionStarted = false;
    this._backendGeneration = 0;
    this._interruptedResponseGeneration = null;
    this._backendAudioPending = false;
    this._assistantActive = false;
    this._lastAudibleGeneration = null;
    this._lastDurableAudibleGeneration = null;
    this._activeProactiveGeneration = null;
    this._missedProactiveWindowPending = false;
    this._turnStrategies.clear();
    this._reasoningPolicyGenerations.clear();
    this._proactiveTurnStrategies.clear();
    this._pendingTurnStrategyGeneration = null;
    this._resetInterruptionCandidate();
    this._speechCandidate = false;
    this._candidateInterruptsResponse = false;
    this._userTurnOpen = false;
    this._bargeInTurn = false;
    if (this._playbackDrainTimer) clearTimeout(this._playbackDrainTimer);
    this._playbackDrainTimer = 0;
    this._audioSegments.clear();
    this._legacySegments.clear();
    this._currentAudioSegment = null;
    this._pendingPcm = [];
    this._audioGate = false;
    this._micLevel = 0;
    this._micWave.fill(0);
    this.cb.onLevel?.(0, this._micWave);
    this.cb.onTransportReset?.();
    this.playbackNode?.port.postMessage({ type: "clear" });
  }

  _onMessage(ev) {
    if (typeof ev.data !== "string") {
      // 下行音频 PCM16 24k
      if (this._audioGate) return;
      let pcm = ev.data;
      let segment = this._currentAudioSegment;
      if (
        usesManagedCascade(this.trace.provider) &&
        this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY
      ) {
        const frame = decodeManagedAudioFrame(ev.data);
        segment = this._acceptManagedAudioFrame(frame);
        if (!segment) return;
        pcm = frame.pcm;
      }
      this.trace.startResponse();
      this.trace.recordOnce("tts_first_audio", TRACE_EVENT.TTS_FIRST_AUDIO, {
        metrics: { audioBytes: pcm?.byteLength || 0 },
      });
      if (
        segment &&
        segment.generation === this._activeProactiveGeneration &&
        this._activeProactiveFirstAudioAt === 0
      ) {
        this._activeProactiveFirstAudioAt = performance.now();
      }
      this.trace.recordOnce("playback_queued", TRACE_EVENT.PLAYBACK_QUEUED, {
        metrics: { audioBytes: pcm?.byteLength || 0 },
      });
      // Worklet reports RMS from samples at the actual speaker boundary. The
      // legacy scheduler has no output callback, so it retains enqueue-time RMS.
      if (!this.playbackNode) this._notePlayLevel(pcm);
      this._enqueuePcm(pcm, segment);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!this._acceptBackendGeneration(msg)) return;
    if (usesManagedCascade(this.trace.provider) && msg.vadShadowSummary !== undefined) {
      this._vadShadowSummary = sanitizeVadShadowSummary(msg.vadShadowSummary);
    }
    switch (msg.type) {
      case "session":
        if (msg.state === "started") {
          this._sessionStarted = true;
          this._interruptedResponseGeneration = null;
          this._memoryContextMode =
            [SESSION_MEMORY_CAPABILITY, TURN_MEMORY_CAPABILITY].includes(msg.memoryContext)
              ? msg.memoryContext
              : "none";
          this._temporalContextMode =
            usesManagedCascade(this.trace.provider) &&
            msg.downlinkAudio === MANAGED_AUDIO_CAPABILITY &&
            msg.temporalContext === TEMPORAL_CONTEXT_CAPABILITY
              ? TEMPORAL_CONTEXT_CAPABILITY
              : "none";
          this._freshTopicMode =
            usesManagedCascade(this.trace.provider) && msg.freshTopic === FRESH_TOPIC_CAPABILITY
              ? FRESH_TOPIC_CAPABILITY
              : "none";
          this._pendingTurnResumeMode =
            usesManagedCascade(this.trace.provider) &&
            msg.pendingTurnResume === PENDING_TURN_RESUME_CAPABILITY
              ? PENDING_TURN_RESUME_CAPABILITY
              : "none";
          if (
            this._freshTopicMode === FRESH_TOPIC_CAPABILITY &&
            this._startupFreshTopics.length &&
            this.ws?.readyState === WebSocket.OPEN
          ) {
            this.ws.send(JSON.stringify({
              type: "fresh_topics",
              items: this._startupFreshTopics,
            }));
          }
          this._startupFreshTopics = [];
        }
        if (msg.state === "started" && usesManagedCascade(this.trace.provider)) {
          this._downlinkAudioMode =
            msg.downlinkAudio === MANAGED_AUDIO_CAPABILITY
              ? MANAGED_AUDIO_CAPABILITY
              : "raw";
          this._ttsStreamingMode =
            this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY &&
            msg.ttsStream === TTS_STREAMING_CAPABILITY
              ? TTS_STREAMING_CAPABILITY
              : "none";
          this.playbackNode?.port.postMessage({
            type: "startup_buffer",
            milliseconds:
              this._ttsStreamingMode === TTS_STREAMING_CAPABILITY
                ? STREAMING_PLAYBACK_STARTUP_MS
                : 0,
          });
          this._interruptionHintMode =
            msg.interruptionHint === INTERRUPTION_HINT_CAPABILITY
              ? INTERRUPTION_HINT_CAPABILITY
              : "none";
          this._interruptionRecoveryMode =
            this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY &&
            msg.interruptionRecovery === INTERRUPTION_RECOVERY_CAPABILITY
              ? INTERRUPTION_RECOVERY_CAPABILITY
              : "none";
          this._responseFinishMode =
            this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY &&
            msg.responseFinish === RESPONSE_FINISH_CAPABILITY
              ? RESPONSE_FINISH_CAPABILITY
              : "none";
          this._vadShadowMode =
            msg.vadShadow === undefined
              ? "disabled"
              : [
                  "shadow-v1",
                  "silero-onnx-shadow-v1",
                  "disabled",
                  "warming",
                  "busy",
                  "unavailable",
                ].includes(msg.vadShadow)
                ? msg.vadShadow
                : "unavailable";
          this._asrRuntime = sanitizeAsrRuntime(msg.asrRuntime);
          this._proactiveTurnMode =
            this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY &&
            msg.proactiveTurn === PROACTIVE_TURN_CAPABILITY
              ? PROACTIVE_TURN_CAPABILITY
              : "none";
          this._scheduleProactiveWelcome();
        }
        if (msg.state === "ended") {
          this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, {
            reason: "provider_terminal",
          });
        }
        this.cb.onState?.(msg.state);
        break;
      case "vad_shadow_summary":
        if (!usesManagedCascade(this.trace.provider)) break;
        this._vadShadowSummary = sanitizeVadShadowSummary(msg.summary);
        if (msg.final === true && msg.summary?.schemaVersion === 1) {
          this._resolveVadShadowFinal?.();
        }
        break;
      case "asr_start":
        this._cancelProactiveWelcome();
        if (this._confirmSpeech()) this.cb.onAsrStart?.();
        break;
      case "speech_candidate":
        this._cancelInterruptionRecovery();
        this._beginSpeechCandidate(msg);
        break;
      case "speech_confirmed":
        if (this._confirmSpeech(msg)) this.cb.onAsrStart?.();
        break;
      case "speech_rejected":
        this._interruptedResponseGeneration = null;
        this._rejectSpeech(msg.reason || "voice_rejected");
        break;
      case "endpoint_soft_end":
        this._recordEndpoint(TRACE_EVENT.ENDPOINT_SOFT_END, msg);
        break;
      case "endpoint_reopened":
        this._recordEndpoint(TRACE_EVENT.ENDPOINT_REOPENED, msg);
        break;
      case "endpoint_committed":
        this._recordEndpoint(TRACE_EVENT.ENDPOINT_COMMITTED, msg);
        break;
      case "asr":
        // asr_end 之后的迟到识别（二遍 ASR 常见）必须忽略，
        // 否则会当成新一轮用户说话，把刚开始的助手语音整段 flush 掉 → 首句静音。
        if (!this._userTurnOpen) {
          if (this._speechCandidate) {
            // Interim ASR is only a preview. Confirming it here would flush
            // an active response before the provider has validated the turn.
            if (msg.interim === false && this._confirmSpeech()) {
              this.cb.onAsrStart?.();
            }
          } else {
            if (this._assistantActive || this._hasPlayback()) return;
            if (this._confirmSpeech()) this.cb.onAsrStart?.();
          }
        }
        this.trace.record(
          msg.interim === false ? TRACE_EVENT.ASR_FINAL : TRACE_EVENT.ASR_PARTIAL,
          { metrics: { interim: msg.interim !== false } },
        );
        if (msg.interim === false) {
          this._pendingUserTurn = true;
          this._traceAsrFinalSeen = true;
          this._latestFinalAsr = msg.text || "";
          const finalAsrText = this._latestFinalAsr.trim();
          if (
            this._userFinalTurns === 0 &&
            finalAsrText &&
            (FAST_SOCIAL_TURN_RE.test(finalAsrText) || CALL_OPENING_RE.test(finalAsrText))
          ) {
            this._openingStyleGeneration = this._backendGeneration;
          }
          if (finalAsrText) this._userFinalTurns += 1;
          if (this._latestFinalAsr.trim()) {
            this._confirmedInterruptionEligible = false;
            this._cancelInterruptionRecovery();
          }
          const policy = classifyRealtimeConversationTurn(this._latestFinalAsr);
          const lateralAllowed = isRealtimeLateralShiftSafe(this._latestFinalAsr);
          const topicActivity = classifyRealtimeTopicActivity(
            this._latestFinalAsr,
            policy,
            lateralAllowed,
          );
          this._proactiveSummary.topicActivity ||= {
            active: 0, neutral: 0, settling: 0, sensitive: 0,
          };
          this._proactiveSummary.topicActivity[topicActivity] = Math.min(
            255,
            this._proactiveSummary.topicActivity[topicActivity] + 1,
          );
          this._applyUserTurnPolicy(policy);
          const softIntent = classifyRealtimeSoftIntent(this._latestFinalAsr);
          const reasoningTopicKey = deriveRealtimeTopicKey(this._latestFinalAsr);
          const topicChanged = Boolean(
            this._reasoningTopicKey &&
            reasoningTopicKey &&
            !REASONING_ANAPHORA_RE.test(this._latestFinalAsr) &&
            !relatedTopicKeys(this._reasoningTopicKey, reasoningTopicKey),
          );
          this._pendingReasoningDecision = this._reasoningController.select({
            turnCategory: FAST_SOCIAL_TURN_RE.test(this._latestFinalAsr.trim())
              ? "greeting"
              : policy,
            signal: classifyRealtimeReasoningSignal(this._latestFinalAsr, softIntent),
            topicChanged: policy === "redirect" || topicChanged,
          });
          if (this._pendingReasoningDecision.source?.startsWith("automatic-") &&
              this._pendingReasoningDecision.source !== "automatic-carry" &&
              this._pendingReasoningDecision.source !== "automatic-fast") {
            this._reasoningTopicKey = reasoningTopicKey;
          } else if (policy === "redirect" || topicChanged ||
                     this._pendingReasoningDecision.source === "fast-control") {
            this._reasoningTopicKey = "";
          }
          this._sendReasoningPolicy(this._backendGeneration);
          if (this._conversationDirector) {
            const actions = this._conversationDirector.dispatch({
              type: "user-turn-final",
              policy,
              softIntent,
              lateralAllowed,
              topicActivity,
              conversationDepth: classifyRealtimeConversationDepth(
                this._latestFinalAsr,
                softIntent,
                topicActivity,
              ),
            });
            const request = actions.find((action) => action.type === "request-reply");
            const strategy = sanitizeTurnStrategy(request?.strategy);
            this._pendingTurnStrategy = strategy
              ? sanitizeTurnStrategy({
                  ...strategy,
                  reasoningPolicy: this._pendingReasoningDecision.policy,
                })
              : null;
            this._proactiveSummary.conversationMoves ||= {
              respond: 0, expand: 0, deepen: 0, associate: 0, recover: 0,
            };
            const moveKey = this._pendingTurnStrategy?.move;
            if (moveKey) {
              this._proactiveSummary.conversationMoves[moveKey] = Math.min(
                255,
                this._proactiveSummary.conversationMoves[moveKey] + 1,
              );
            }
            this._pendingTurnStrategyGeneration = this._backendGeneration;
          }
          if (policy === "substantive") this._observeImportantTopic(this._latestFinalAsr);
        }
        this.cb.onAsr?.(msg.text || "", { interim: msg.interim !== false });
        break;
      case "asr_end": {
        const hadUserTurn = this._userTurnOpen;
        if (this._speechCandidate && !this._userTurnOpen) {
          this._rejectSpeech("voice_rejected");
        }
        if (hadUserTurn && !this._traceAsrFinalSeen) {
          this.trace.recordOnce("asr_final", TRACE_EVENT.ASR_FINAL, {
            metrics: { interim: false },
          });
        }
        this._userTurnOpen = false;
        if (hadUserTurn) {
          this.cb.onAsrEnd?.();
          if (this._confirmedInterruptionEligible && !this._latestFinalAsr.trim()) {
            this._scheduleInterruptionRecovery();
          } else {
            this._beginThinkingFeedback("reasoning");
            this.trace.startResponse();
            this.trace.recordOnce("llm_request", TRACE_EVENT.LLM_REQUEST);
          }
        }
        this._confirmedInterruptionEligible = false;
        break;
      }
      case "memory_context_request":
        if (
          this._memoryContextMode === TURN_MEMORY_CAPABILITY &&
          Number.isSafeInteger(msg.generation) &&
          msg.generation === this._backendGeneration
        ) {
          if (this._pendingUserTurn && this._pendingTurnStrategy) {
            this._pendingTurnStrategyGeneration = msg.generation;
          }
          this._memoryContextRequestedAt = performance.now();
          this._pendingMemoryContextReason =
            msg.reason === "proactive-topic" ? "proactive-topic" : "turn";
          this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_REQUEST);
          const conversationMove = sanitizeTurnStrategy(this._pendingTurnStrategy)?.move || "none";
          this.cb.onMemoryContextRequest?.({
            generation: msg.generation,
            reason: msg.reason === "proactive-topic" ? "proactive-topic" : "turn",
            ...(conversationMove === "associate" ? { conversationMove } : {}),
          });
        }
        break;
      case "memory_context_timeout":
        if (
          this._memoryContextMode === TURN_MEMORY_CAPABILITY &&
          Number.isSafeInteger(msg.generation) &&
          msg.generation === this._backendGeneration
        ) {
          const latencyMs = this._memoryContextRequestedAt
            ? Math.max(0, performance.now() - this._memoryContextRequestedAt)
            : 0;
          this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_RESPONSE, {
            metrics: { accepted: false, timedOut: true, itemCount: 0, memoryChars: 0, latencyMs },
          });
          this._memoryContextRequestedAt = 0;
        }
        break;
      case "assistant":
        this._cancelProactiveWelcome();
        this._assistantActive = true;
        this._beginThinkingFeedback("synthesizing", { allowFiller: false });
        this.trace.startResponse();
        this.trace.recordOnce("llm_first_token", TRACE_EVENT.LLM_FIRST_TOKEN);
        this._assistantDraftGeneration = Number.isSafeInteger(msg.generation)
          ? msg.generation
          : this._backendGeneration;
        this.cb.onAssistant?.(msg.text || "", { generation: msg.generation });
        break;
      case "thinking_filler": {
        if (
          !usesManagedCascade(this.trace.provider) ||
          msg.runtimeGenerated !== true ||
          msg.format !== "pcm16le" ||
          msg.sampleRate !== OUTPUT_RATE ||
          (Number.isSafeInteger(msg.generation) && msg.generation !== this._backendGeneration)
        ) break;
        const filler = decodeThinkingFiller(msg.audio);
        if (!filler || filler.byteLength > OUTPUT_RATE * 2 * 2) break;
        this.cb.onThinkingFillerOffer?.();
        this._enqueuePcm(filler, null);
        break;
      }
      case "assistant_end":
        this._assistantActive = false;
        this._armResponseFinishWatchdog(msg.generation);
        this.trace.recordOnce("llm_response", TRACE_EVENT.LLM_RESPONSE);
        if (this.trace.mode === "end_to_end") {
          this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        }
        this.cb.onAssistantEnd?.();
        break;
      case "response_finish_recovered":
        this._onResponseFinishRecovered(msg);
        break;
      case "assistant_discarded":
        if (!usesManagedCascade(this.trace.provider)) break;
        this._assistantActive = false;
        this.cb.onAssistantDiscarded?.({ generation: msg.generation });
        if (msg.generation === this._assistantDraftGeneration) {
          this._assistantDraftGeneration = null;
        }
        break;
      case "reply_cancel_timeout":
        if (usesManagedCascade(this.trace.provider)) {
          const current = this._proactiveSummary.replyCancelTimeouts;
          this._proactiveSummary.replyCancelTimeouts =
            Number.isSafeInteger(current) && current >= 0 ? Math.min(255, current + 1) : 1;
        }
        break;
      case "proactive_turn_status":
        if (
          !usesManagedCascade(this.trace.provider) ||
          this._proactiveTurnMode !== PROACTIVE_TURN_CAPABILITY
        ) break;
        if (["accepted", "vetoed", "cancelled"].includes(msg.state)) {
          this._noteProactiveStatus(msg);
        }
        if (msg.state === "cancelled") {
          this._backendAudioPending = false;
          this._assistantActive = false;
          this._flushPlayback("speech_candidate");
        }
        break;
      case "interruption_recovery_status":
        if (this._interruptionRecoveryMode === INTERRUPTION_RECOVERY_CAPABILITY) {
          this._noteInterruptionRecoveryStatus(msg);
        }
        break;
      case "tts_start":
        this._backendAudioPending = true;
        this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        break;
      case "tts_end":
        this._backendAudioPending = false;
        this._clearResponseFinishWatchdog();
        if (!this._hasPlayback()) this._schedulePlaybackCompletion();
        break;
      case "audio_segment_start":
        this._beginAudioSegment(msg);
        break;
      case "audio_segment_end":
        this._endAudioSegment(msg);
        break;
      case "speaking":
        this._endThinkingFeedback();
        this._assistantActive = true;
        this._audioGate = false;
        this.trace.startResponse();
        this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        this.cb.onSpeaking?.();
        break;
      case "usage":
        this._recordPrefillSample(msg.llm);
        this.cb.onUsage?.(msg);
        break;
      case "error":
        this._endThinkingFeedback();
        this._clearResponseFinishWatchdog();
        this._backendAudioPending = false;
        if (this.trace.responseId && this.trace.state.response === "active") {
          this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: "error" });
        }
        if (msg.recoverable === true && usesManagedCascade(this.trace.provider)) {
          if (Number.isSafeInteger(this._assistantDraftGeneration)) {
            this.cb.onAssistantDiscarded?.({
              generation: this._assistantDraftGeneration,
              preserveAudible: this._lastAudibleGeneration === this._assistantDraftGeneration,
            });
            this._assistantDraftGeneration = null;
          }
          this._assistantActive = false;
          this._flushPlayback("response_error");
          const restartRequired =
            msg.restartRequired === true && this.trace.provider === "voxcpm";
          if (restartRequired) {
            void this._recoverTransport({ restartImmediately: true });
          } else {
            this._pendingUserTurn = false;
            const callback = this.cb.onResponseError || this.cb.onError;
            callback?.(new Error(msg.message || "本轮语音处理失败，请继续说话重试"));
          }
        } else {
          if (!this._hasPlayback()) this._schedulePlaybackCompletion();
          this.cb.onError?.(new Error(msg.message || "实时语音出错"));
        }
        break;
      default:
        break;
    }
  }

  /** 回传当前 final turn 的有界记忆卡片；旧 generation、旧服务或火山路径拒绝发送。 */
  sendMemoryContext({ generation, items, temporalContext, freshTopics } = {}) {
    if (
      this._memoryContextMode === TURN_MEMORY_CAPABILITY &&
      Number.isSafeInteger(generation) &&
      generation !== this._backendGeneration
    ) {
      this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_RESPONSE, {
        metrics: { accepted: false, stale: true, itemCount: 0, memoryChars: 0 },
      });
      return false;
    }
    if (
      this._memoryContextMode !== TURN_MEMORY_CAPABILITY ||
      !Number.isSafeInteger(generation) ||
      generation !== this._backendGeneration ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    const safe = [];
    let chars = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (safe.length >= MAX_TURN_MEMORY_ITEMS) break;
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      if (!text || chars + text.length > MAX_TURN_MEMORY_CHARS) continue;
      safe.push({
        kind: ["fact", "episode", "commitment", "memory"].includes(item.kind)
          ? item.kind
          : "memory",
        text,
        uncertain: item.uncertain === true,
        pinned: item.pinned === true,
      });
      chars += text.length;
    }
    try {
      const temporal = this._temporalContextMode === TEMPORAL_CONTEXT_CAPABILITY &&
        temporalContext && typeof temporalContext === "object"
        ? {
            date: String(temporalContext.date || "").slice(0, 10),
            weekday: String(temporalContext.weekday || "").slice(0, 3),
            time: String(temporalContext.time || "").slice(0, 5),
            timeZone: String(temporalContext.timeZone || "").slice(0, 64),
          }
        : undefined;
      const turnStrategy = this._conversationDirector &&
        generation === this._pendingTurnStrategyGeneration
        ? sanitizeTurnStrategy(this._pendingTurnStrategy)
        : null;
      const openingStyle = generation === this._openingStyleGeneration
        ? this._openingStyle
        : null;
      const reasoningDecision = this._pendingMemoryContextReason === "proactive-topic"
        ? { policy: "fast", source: "fast-control" }
        : this._pendingReasoningDecision;
      const reasoningPolicy = ["fast", "deliberate"].includes(
        reasoningDecision?.policy,
      ) ? reasoningDecision.policy : "fast";
      if (turnStrategy) {
        this._turnStrategies.set(generation, turnStrategy);
        while (this._turnStrategies.size > 8) {
          this._turnStrategies.delete(this._turnStrategies.keys().next().value);
        }
      }
      const safeFreshTopics = this._freshTopicMode === FRESH_TOPIC_CAPABILITY
        ? sanitizeFreshTopics(freshTopics)
        : [];
      this.ws.send(JSON.stringify({
        type: "memory_context",
        generation,
        items: safe,
        ...(temporal ? { temporalContext: temporal } : {}),
        ...(turnStrategy ? { turnStrategy } : {}),
        ...(openingStyle ? { openingStyle } : {}),
        reasoningPolicy,
        ...(safeFreshTopics.length ? { freshTopics: safeFreshTopics } : {}),
      }));
      if (turnStrategy) {
        this._noteTurnStrategy(turnStrategy, {
          includeReasoning: !this._reasoningPolicyGenerations.has(generation),
        });
      }
      if (openingStyle) this._openingStyleGeneration = null;
      if (!this._reasoningPolicyGenerations.has(generation)) {
        this._noteReasoningSource(reasoningDecision?.source);
      }
      this._pendingMemoryContextReason = "turn";
    } catch {
      this._pendingMemoryContextReason = "turn";
      this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_RESPONSE, {
        metrics: { accepted: false, itemCount: 0, memoryChars: 0 },
      });
      return false;
    }
    const latencyMs = this._memoryContextRequestedAt
      ? Math.max(0, performance.now() - this._memoryContextRequestedAt)
      : 0;
    this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_RESPONSE, {
      metrics: {
        accepted: true,
        itemCount: safe.length,
        memoryChars: chars,
        latencyMs,
      },
    });
    this._memoryContextRequestedAt = 0;
    return true;
  }

  _sendReasoningPolicy(generation) {
    if (
      !usesManagedCascade(this.trace.provider) ||
      !this._sessionStarted ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) return false;
    const policy = ["fast", "deliberate"].includes(this._pendingReasoningDecision?.policy)
      ? this._pendingReasoningDecision.policy
      : "fast";
    this.ws.send(JSON.stringify({ type: "reasoning_policy", generation, policy }));
    if (!this._reasoningPolicyGenerations.has(generation)) {
      this._reasoningPolicyGenerations.add(generation);
      while (this._reasoningPolicyGenerations.size > 8) {
        this._reasoningPolicyGenerations.delete(
          this._reasoningPolicyGenerations.values().next().value,
        );
      }
      this._noteReasoningPolicy(policy);
      this._noteReasoningSource(this._pendingReasoningDecision?.source);
    }
    return true;
  }

  // ---- 电平：供声波可视化（麦克风 + 下行播放取较大值）----
  _rmsI16(arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    if (!i16.length) return 0;
    let sum = 0;
    // 抽样，避免每帧全量扫描。
    const step = Math.max(1, (i16.length / 64) | 0);
    let n = 0;
    for (let i = 0; i < i16.length; i += step) {
      const v = i16[i] / 0x8000;
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  }

  _noteMicLevel(arrayBuffer) {
    const r = this._rmsI16(arrayBuffer);
    this._micLevel = Math.max(this._micLevel * 0.6, r);
    this._micWave = this._pcmEnvelope(arrayBuffer);
  }

  _notePlayLevel(arrayBuffer) {
    const r = this._rmsI16(arrayBuffer);
    this._playLevel = Math.max(this._playLevel * 0.55, r);
    this._playWave = this._pcmEnvelope(arrayBuffer);
  }

  // 只保留固定 48 段包络，不保留或转发原始 PCM；供 UI 做短时实时波形。
  _pcmEnvelope(arrayBuffer, bins = 48) {
    const i16 = new Int16Array(arrayBuffer);
    const result = new Float32Array(bins);
    if (!i16.length) return result;
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor((bin * i16.length) / bins);
      if (start >= i16.length) continue;
      const end = Math.max(start + 1, Math.floor(((bin + 1) * i16.length) / bins));
      let sum = 0;
      for (let i = start; i < end; i++) {
        const value = i16[i] / 0x8000;
        sum += value * value;
      }
      result[bin] = Math.min(1, Math.sqrt(sum / (end - start)) * 3.6);
    }
    return result;
  }

  _startLevelLoop() {
    const tick = () => {
      if (this.stopped) return;
      // 缓慢衰减，让波形有回落感。
      this._micLevel *= 0.88;
      this._playLevel *= 0.9;
      const level = Math.min(1, Math.max(this._micLevel, this._playLevel) * 2.4);
      const waveform = new Float32Array(48);
      for (let i = 0; i < waveform.length; i++) {
        this._micWave[i] *= 0.86;
        this._playWave[i] *= 0.89;
        waveform[i] = Math.max(this._micWave[i], this._playWave[i]);
      }
      this.cb.onLevel?.(level, waveform);
      this._levelRaf = requestAnimationFrame(tick);
    };
    this._levelRaf = requestAnimationFrame(tick);
  }

  // ---- 下行播放：把 24k PCM16 顺序调度到 AudioContext ----

  /** 在用户手势同步栈内创建 context（不要 await）。采集与播放共用。 */
  _initAudioCtx() {
    if (!this.audioCtx) {
      // 不强制采样率（部分 WebView 不允许任意值会抛错）；
      // createBuffer 里标记 24k，播放时由 Web Audio 自动重采样。
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = this.audioCtx;
    if (ctx.state !== "running" && ctx.state !== "closed") {
      ctx.resume().catch(() => {});
    }
    if (!this._outGain) {
      this._outGain = ctx.createGain();
      this._outGain.gain.value = getVoiceGain();
      this._outGain.connect(ctx.destination);
      this._unsubVol = onVoiceGainChange((g) => {
        if (this._outGain) this._outGain.gain.value = g;
      });
    }
    // 手势栈内播一帧近乎静音的缓冲，真正「解锁」WKWebView 音频会话。
    try {
      const n = Math.max(1, (ctx.sampleRate * 0.05) | 0);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(g);
      g.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    // 静音振荡器保活，避免通话中途 context 被自动挂起。
    if (!this._keepAliveOsc) {
      try {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start();
        this._keepAliveOsc = osc;
        this._keepAliveGain = g;
      } catch {
        /* ignore */
      }
    }
    this.playHead = ctx.currentTime;
  }

  async _resumeAudioCtx() {
    if (!this.audioCtx || this.stopped) return;
    if (this.audioCtx.state !== "running" && this.audioCtx.state !== "closed") {
      try {
        await this.audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
    this.playHead = this.audioCtx.currentTime;
    this._flushPendingPcm();
  }

  // 聊天窗口被系统隐藏后 WebView 可能自动 suspend AudioContext；重新显示时
  // 由 chat.js 调用，保持实时会话和播放队列不变。
  async resumeAudio() {
    if (this.stopped) return;
    await this._resumeAudioCtx();
  }

  _beginThinkingFeedback(phase = "reasoning", { allowFiller = true } = {}) {
    if (this.stopped) return;
    if (this._thinkingFeedbackTimer) clearTimeout(this._thinkingFeedbackTimer);
    this._thinkingFeedbackTimer = 0;
    if (phase === "reasoning") this._thinkingFillerOffered = false;
    this._thinkingPhase = phase === "synthesizing" ? "synthesizing" : "reasoning";
    this.cb.onThinking?.(this._thinkingPhase);
    if (!allowFiller || this._thinkingPhase !== "reasoning") return;
    this._thinkingFeedbackTimer = setTimeout(() => {
      this._thinkingFeedbackTimer = 0;
      if (
        this.stopped ||
        this._thinkingPhase !== "reasoning" ||
        this._thinkingFillerOffered
      ) return;
      this._thinkingFillerOffered = true;
      this.cb.onThinkingFillerOffer?.();
    }, this._thinkingFeedbackDelayMs);
  }

  _endThinkingFeedback() {
    if (this._thinkingFeedbackTimer) clearTimeout(this._thinkingFeedbackTimer);
    this._thinkingFeedbackTimer = 0;
    if (this._thinkingPhase === "idle") return;
    this._thinkingPhase = "idle";
    this.cb.onThinking?.("idle");
  }

  _beginSpeechCandidate(msg = {}) {
    this._endThinkingFeedback();
    this._cancelInterruptionRecovery();
    if (this._speechCandidate || this._userTurnOpen) return false;
    this._resetInterruptionCandidate();
    if (this._proactiveGreetingTimer || this._proactiveLeadTimer) {
      this._noteProactiveVeto("speech");
      if (this._proactiveLeadTimer) this._missedProactiveWindowPending = true;
    }
    this._pendingProactiveRhythmSignal = this._captureProactiveRhythmSignal();
    this._cancelProactiveTimers();
    this._speechCandidate = true;
    this._candidateInterruptsResponse = this._assistantActive || this._hasPlayback();
    const candidateId = msg.candidateId;
    if (
      this._candidateInterruptsResponse &&
      this._interruptionHintMode === INTERRUPTION_HINT_CAPABILITY &&
      this.playbackNode &&
      Number.isSafeInteger(candidateId) &&
      candidateId >= 1 &&
      candidateId <= CANDIDATE_ID_MAX
    ) {
      this._candidateId = candidateId;
      this._candidateSegmentKeys = new Set(
        [...this._audioSegments.entries()]
          .filter(([, segment]) => !segment.dropped && !segment.completed)
          .map(([key]) => key),
      );
      this.playbackNode.port.postMessage({ type: "candidate_snapshot", candidateId });
    }
    this.trace.record(TRACE_EVENT.SPEECH_CANDIDATE, {
      metrics: { confidence: Number(msg.confidence) || 0 },
    });
    this._duckPlayback();
    this.cb.onSpeechCandidate?.();
    return true;
  }

  _resetInterruptionCandidate() {
    if (this._candidateSnapshotTimer) clearTimeout(this._candidateSnapshotTimer);
    this._candidateSnapshotTimer = 0;
    this._candidateId = null;
    this._candidateSnapshot = null;
    this._candidateSegmentKeys = null;
    this._pendingConfirmedCandidate = null;
  }

  _scheduleProactiveWelcome() {
    if (
      this._proactiveWelcomeSent ||
      this._proactiveGreetingTimer ||
      !this._sessionStarted ||
      !this._micReady ||
      this._proactiveTurnMode !== PROACTIVE_TURN_CAPABILITY ||
      this._conversationMode === "follow-user"
    ) {
      return;
    }
    this._proactiveGreetingTimer = setTimeout(() => {
      this._proactiveGreetingTimer = 0;
      if (
        this.stopped ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (this._speechCandidate) return this._noteProactiveVeto("speech");
      if (this._userTurnOpen) return this._noteProactiveVeto("asr");
      if (this._assistantActive) return this._noteProactiveVeto("reply");
      if (this._hasPlayback()) return this._noteProactiveVeto("playback");
      this._proactiveWelcomeSent = true;
      this._sendProactiveTurn("welcome");
    }, this._proactiveGreetingDelayMs);
  }

  _cancelProactiveWelcome() {
    if (this._proactiveGreetingTimer) clearTimeout(this._proactiveGreetingTimer);
    this._proactiveGreetingTimer = 0;
  }

  _cancelProactiveTimers() {
    this._cancelProactiveWelcome();
    if (this._proactiveLeadTimer) clearTimeout(this._proactiveLeadTimer);
    this._proactiveLeadTimer = 0;
  }

  _noteInterruptionRecovery(field, eventType) {
    this._interruptionRecoverySummary[field] = Math.min(
      255,
      this._interruptionRecoverySummary[field] + 1,
    );
    this.trace.record(eventType);
  }

  _noteTurnStrategy(value, { includeReasoning = true } = {}) {
    const strategy = sanitizeTurnStrategy(value);
    if (!strategy) return false;
    const increment = (bucket, key) => {
      bucket[key] = Math.min(255, bucket[key] + 1);
    };
    increment(this._turnStrategySummary.moves, strategy.move);
    increment(this._turnStrategySummary.stances, strategy.stance);
    if (includeReasoning) this._noteReasoningPolicy(strategy.reasoningPolicy);
    increment(
      this._turnStrategySummary.responseCues,
      strategy.responseCue === "low-burden" ? "lowBurden" : strategy.responseCue,
    );
    increment(this._turnStrategySummary.depths, ["zero", "one", "two", "three"][strategy.depth]);
    return true;
  }

  _noteReasoningPolicy(policy) {
    if (!["fast", "deliberate"].includes(policy)) return false;
    this._turnStrategySummary.reasoningPolicies[policy] = Math.min(
      255,
      this._turnStrategySummary.reasoningPolicies[policy] + 1,
    );
    return true;
  }

  _noteReasoningSource(source) {
    const key = source === "preference-off"
      ? "preferenceOff"
      : source === "preference-always"
        ? "preferenceAlways"
        : source === "automatic-carry"
          ? "automaticCarry"
          : source === "automatic-fast"
            ? "automaticFast"
            : source === "fast-control"
              ? "fastControl"
              : typeof source === "string" && source.startsWith("automatic-")
                ? "automaticSignal"
                : null;
    if (!key) return false;
    this._turnStrategySummary.sources[key] = Math.min(
      255,
      this._turnStrategySummary.sources[key] + 1,
    );
    return true;
  }

  _cancelInterruptionRecovery() {
    if (this._interruptionRecoveryTimer) clearTimeout(this._interruptionRecoveryTimer);
    this._interruptionRecoveryTimer = 0;
    if (!this._pendingInterruptionRecovery) return false;
    this._pendingInterruptionRecovery = null;
    this._noteInterruptionRecovery(
      "cancelled",
      TRACE_EVENT.INTERRUPTION_RECOVERY_CANCELLED,
    );
    return true;
  }

  _hasInterruptionRecoveryOccupancy() {
    return this._assistantActive ||
      this._backendAudioPending ||
      this._hasPlayback() ||
      this._currentAudioSegment !== null ||
      this._audioSegments.size > 0 ||
      this._legacySegments.size > 0;
  }

  _armInterruptionRecovery(delayMs) {
    if (!this._pendingInterruptionRecovery || this._interruptionRecoveryTimer) return;
    this._interruptionRecoveryTimer = setTimeout(() => {
      this._interruptionRecoveryTimer = 0;
      this._tryInterruptionRecovery();
    }, delayMs);
  }

  _scheduleInterruptionRecovery() {
    if (
      this._interruptionRecoveryMode !== INTERRUPTION_RECOVERY_CAPABILITY ||
      this.stopped ||
      this._pendingInterruptionRecovery
    ) return false;
    this._interruptionRecoveryRequestId =
      (this._interruptionRecoveryRequestId % 0xffffffff) + 1;
    this._pendingInterruptionRecovery = {
      requestId: this._interruptionRecoveryRequestId,
      expectedGeneration: this._backendGeneration,
      sent: false,
      started: false,
    };
    this._noteInterruptionRecovery(
      "scheduled",
      TRACE_EVENT.INTERRUPTION_RECOVERY_SCHEDULED,
    );
    this._armInterruptionRecovery(this._interruptionRecoveryGraceMs);
    return true;
  }

  _tryInterruptionRecovery() {
    const pending = this._pendingInterruptionRecovery;
    if (!pending || pending.sent) return;
    if (
      this.stopped ||
      this._interruptionRecoveryMode !== INTERRUPTION_RECOVERY_CAPABILITY ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      this._backendGeneration !== pending.expectedGeneration
    ) {
      this._cancelInterruptionRecovery();
      return;
    }
    if (this._speechCandidate || this._userTurnOpen) {
      this._cancelInterruptionRecovery();
      return;
    }
    if (this._hasInterruptionRecoveryOccupancy()) {
      this._armInterruptionRecovery(this._interruptionRecoveryDeferMs);
      return;
    }
    pending.sent = true;
    const reasoningDecision = this._reasoningController.select({ turnCategory: "recovery" });
    this._reasoningTopicKey = "";
    const turnStrategy = createRecoveryTurnStrategy();
    this.ws.send(JSON.stringify({
      type: "interruption_recovery",
      requestId: pending.requestId,
      expectedGeneration: pending.expectedGeneration,
      reasoningPolicy: reasoningDecision.policy,
      turnStrategy,
    }));
    this._noteTurnStrategy(turnStrategy);
    this._noteReasoningSource(reasoningDecision.source);
  }

  _noteInterruptionRecoveryStatus(msg) {
    const pending = this._pendingInterruptionRecovery;
    if (!pending || msg.requestId !== pending.requestId) return;
    if (msg.state === "deferred" && pending.sent && !pending.started) {
      pending.sent = false;
      this._armInterruptionRecovery(this._interruptionRecoveryDeferMs);
      return;
    }
    if (msg.state === "started" && pending.sent && !pending.started) {
      pending.started = true;
      this._noteInterruptionRecovery(
        "started",
        TRACE_EVENT.INTERRUPTION_RECOVERY_STARTED,
      );
      return;
    }
    if (msg.state === "completed" && pending.started) {
      this._noteInterruptionRecovery(
        "completed",
        TRACE_EVENT.INTERRUPTION_RECOVERY_COMPLETED,
      );
      this._pendingInterruptionRecovery = null;
      return;
    }
    if (msg.state === "cancelled") this._cancelInterruptionRecovery();
  }

  _sendProactiveTurn(kind, turnStrategy = null, topicRevisit = null, topicProposal = null) {
    if (
      !PROACTIVE_KINDS.has(kind) ||
      this.stopped ||
      this._proactiveTurnMode !== PROACTIVE_TURN_CAPABILITY ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) return false;
    this._proactiveTriggerId += 1;
    const triggerId = this._proactiveTriggerId;
    this._proactivePending.set(triggerId, kind);
    const safeStrategy = sanitizeTurnStrategy(turnStrategy);
    if (safeStrategy) this._proactiveTurnStrategies.set(triggerId, safeStrategy);
    if (topicProposal) this._proactiveTopicProposals.set(triggerId, topicProposal);
    while (this._proactivePending.size > 8) {
      const oldest = this._proactivePending.keys().next().value;
      this._proactivePending.delete(oldest);
      this._proactiveTurnStrategies.delete(oldest);
      this._proactiveTopicProposals.delete(oldest);
    }
    this._proactiveSummary.candidates += 1;
    const reasoningDecision = this._reasoningController.select({ turnCategory: "proactive" });
    this._reasoningTopicKey = "";
    const summaryKind = kind === "revisit" ? "idle" : kind;
    this._proactiveSummary.triggerKinds[summaryKind] += 1;
    const message = {
      type: "proactive_turn",
      triggerId,
      kind,
      ...(kind === "welcome" ? { openingStyle: this._openingStyle } : {}),
      reasoningPolicy: reasoningDecision.policy,
      ...(safeStrategy ? { turnStrategy: safeStrategy } : {}),
      ...(topicRevisit ? { topicRevisit } : {}),
    };
    this.ws.send(JSON.stringify(message));
    if (safeStrategy) this._noteTurnStrategy(safeStrategy);
    else this._noteReasoningPolicy(reasoningDecision.policy);
    this._noteReasoningSource(reasoningDecision.source);
    return true;
  }

  _sendTopicTransition(turnStrategy = null) {
    const proposal = this._sessionTopicLedger?.proposeTransition();
    const kind = proposal?.kind === "revisit" ? "revisit" : "idle";
    const topicRevisit = proposal?.kind === "revisit"
      ? { category: proposal.category, context: proposal.context }
      : null;
    return this._sendProactiveTurn(kind, turnStrategy, topicRevisit, proposal);
  }

  _noteProactiveVeto(reason) {
    if (Object.hasOwn(this._proactiveSummary.vetoReasons, reason)) {
      this._proactiveSummary.vetoReasons[reason] += 1;
    }
  }

  _captureProactiveRhythmSignal() {
    const triggerId = this._activeProactiveTriggerId;
    if (
      triggerId === null ||
      triggerId === this._proactiveRhythm.lastNegativeTriggerId ||
      this._activeProactiveGeneration === null
    ) return null;
    const beforeAudio = this._activeProactiveFirstAudioAt === 0;
    const duringOpening =
      !beforeAudio && performance.now() - this._activeProactiveFirstAudioAt <= 1000;
    if (!beforeAudio && !duringOpening) return null;
    return { triggerId, beforeAudio };
  }

  _commitProactiveRhythmSignal() {
    const signal = this._pendingProactiveRhythmSignal;
    this._pendingProactiveRhythmSignal = null;
    if (!signal || signal.triggerId === this._proactiveRhythm.lastNegativeTriggerId) return;
    const { triggerId, beforeAudio } = signal;
    this._proactiveRhythm.lastNegativeTriggerId = triggerId;
    this._proactiveRhythm.negativeSignals += 1;
    if (beforeAudio) this._proactiveSummary.preAudioUserReclaims += 1;
    else this._proactiveSummary.earlyPlaybackInterruptions += 1;
    if (this._proactiveRhythm.negativeSignals === 1) {
      this._proactiveRhythm.delayMultiplier = 1.5;
      this._proactiveSummary.rhythmBackoffs += 1;
    } else if (this._proactiveRhythm.negativeSignals >= 2 && !this._proactiveRhythm.stopped) {
      this._proactiveRhythm.stopped = true;
      this._proactiveSummary.rhythmStops += 1;
    }
  }

  _noteProactiveStatus(msg) {
    const kind =
      this._proactivePending.get(msg.triggerId) ||
      (msg.triggerId === this._activeProactiveTriggerId
        ? this._topicLead.lastProactiveKind
        : null);
    if (!kind) return;
    const traceEvent = {
      accepted: TRACE_EVENT.PROACTIVE_TURN_ACCEPTED,
      vetoed: TRACE_EVENT.PROACTIVE_TURN_VETOED,
      cancelled: TRACE_EVENT.PROACTIVE_TURN_CANCELLED,
    }[msg.state];
    this.trace.record(traceEvent, {
      generationId: Number.isSafeInteger(msg.generation) && msg.generation >= 0
        ? msg.generation
        : undefined,
    });
    if (msg.state === "vetoed") {
      this._proactivePending.delete(msg.triggerId);
      this._proactiveTurnStrategies.delete(msg.triggerId);
      this._proactiveTopicProposals.delete(msg.triggerId);
      this._noteProactiveVeto(msg.reason);
    }
    this._proactiveSummary[msg.state] += 1;
    if (msg.state === "accepted") {
      const turnStrategy = this._proactiveTurnStrategies.get(msg.triggerId) || null;
      const topicProposal = this._proactiveTopicProposals.get(msg.triggerId) || null;
      this._proactivePending.delete(msg.triggerId);
      this._proactiveTurnStrategies.delete(msg.triggerId);
      this._proactiveTopicProposals.delete(msg.triggerId);
      this._activeProactiveTriggerId = msg.triggerId;
      if (Number.isSafeInteger(msg.generation)) {
        this._activeProactiveGeneration = msg.generation;
        this._activeProactiveFirstAudioAt = 0;
        if (turnStrategy) {
          this._turnStrategies.set(msg.generation, turnStrategy);
          while (this._turnStrategies.size > 8) {
            this._turnStrategies.delete(this._turnStrategies.keys().next().value);
          }
        }
      }
      this._sessionTopicLedger?.commitTransition(topicProposal);
      this._conversationDirector?.dispatch({
        type: "proactive-accepted",
        kind: kind === "revisit" ? "idle" : kind,
      });
      this._beginThinkingFeedback("reasoning");
      this._topicLead.proactiveTurns += 1;
      this._topicLead.aiTurnsOnTopic += 1;
      this._topicLead.lastProactiveKind = kind;
      this._topicLead.phase = kind === "idle" || kind === "revisit" ? "opening" : "expanding";
      this._proactiveSummary.proactiveTurns += 1;
      if (kind === "idle" || kind === "revisit") {
        this._rememberTopicKey(this._topicLead.topicKey);
        this._topicLead.topicKey = "";
        this._topicLead.repeatedTopic = false;
        this._topicLead.topicSwitches += 1;
        this._proactiveSummary.topicSwitches += 1;
      }
    }
    if (msg.state === "cancelled") {
      this._proactivePending.delete(msg.triggerId);
      this._proactiveTurnStrategies.delete(msg.triggerId);
      this._proactiveTopicProposals.delete(msg.triggerId);
      this._activeProactiveTriggerId = null;
      this._activeProactiveGeneration = null;
      this._activeProactiveFirstAudioAt = 0;
    }
  }

  _applyUserTurnPolicy(policy) {
    if (this._proactiveLeadTimer) {
      this._noteProactiveVeto("asr");
      if (!["pause", "redirect"].includes(policy)) {
        this._conversationDirector?.dispatch({ type: "proactive-window-missed", reason: "asr" });
      }
    }
    this._cancelProactiveTimers();
    this._activeProactiveGeneration = null;
    this._activeProactiveFirstAudioAt = 0;
    this._topicLead.userEngagement = policy;
    if (Object.hasOwn(this._proactiveSummary.engagementCategories, policy)) {
      this._proactiveSummary.engagementCategories[policy] += 1;
    }
    if (policy === "pause") {
      this._topicLead.paused = true;
      this._topicLead.phase = "closing";
      return;
    }
    if (policy === "redirect") {
      this._sessionTopicLedger?.seal(this._activeImportantTopicKey);
      this._activeImportantTopicKey = "";
      this._rememberTopicKey(this._topicLead.topicKey);
      this._topicLead.topicKey = deriveRealtimeTopicKey(this._latestFinalAsr);
      this._topicLead.repeatedTopic = false;
      this._topicLead.paused = false;
      this._topicLead.phase = "opening";
      this._topicLead.aiTurnsOnTopic = 0;
      this._topicLead.proactiveTurns = 0;
      this._topicLead.consecutiveShortReplies = 0;
      this._topicLead.lastProactiveKind = "none";
      return;
    }
    if (policy === "resume") {
      this._topicLead.paused = false;
      this._topicLead.phase = "expanding";
      this._topicLead.proactiveTurns = 0;
      this._topicLead.lastProactiveKind = "none";
      this._topicLead.consecutiveShortReplies = 0;
      this._proactiveRhythm.delayMultiplier = 1;
      this._proactiveRhythm.negativeSignals = 0;
      this._proactiveRhythm.stopped = false;
      this._proactiveRhythm.lastNegativeTriggerId = null;
      return;
    }
    if (ENGAGEMENT_POLICIES.has(policy)) {
      this._topicLead.paused = false;
      this._topicLead.phase = "expanding";
      this._topicLead.proactiveTurns = 0;
      this._topicLead.lastProactiveKind = "none";
      this._topicLead.consecutiveShortReplies = Math.min(
        3,
        this._topicLead.consecutiveShortReplies + 1,
      );
      return;
    }
    if (policy === "substantive") {
      const nextTopicKey = deriveRealtimeTopicKey(this._latestFinalAsr);
      if (nextTopicKey && nextTopicKey !== this._topicLead.topicKey) {
        this._rememberTopicKey(this._topicLead.topicKey);
        this._topicLead.topicKey = nextTopicKey;
      }
      this._topicLead.repeatedTopic = false;
      this._topicLead.paused = false;
      this._topicLead.phase = "inviting";
      this._topicLead.proactiveTurns = 0;
      this._topicLead.consecutiveShortReplies = 0;
      this._topicLead.lastProactiveKind = "none";
    }
  }

  _rememberTopicKey(topicKey) {
    if (!topicKey || this._topicLead.topicsUsed.includes(topicKey)) return;
    this._topicLead.topicsUsed.push(topicKey);
    while (this._topicLead.topicsUsed.length > MAX_TOPICS_USED) {
      this._topicLead.topicsUsed.shift();
    }
  }

  _observeImportantTopic(text) {
    if (!this._sessionTopicLedger) return;
    const category = classifyImportantTopicBranch(text);
    if (category === "none") return;
    const topicKey = deriveRealtimeTopicKey(text);
    if (!topicKey) return;
    if (this._sessionTopicLedger.observe({ topicKey, category, context: text })) {
      this._activeImportantTopicKey = topicKey;
    }
  }

  _noteAudibleTopic(text) {
    const topicKey = deriveRealtimeTopicKey(text);
    if (!topicKey) return;
    if (!this._topicLead.topicKey) {
      this._topicLead.topicKey = topicKey;
      this._topicLead.repeatedTopic = this._topicLead.topicsUsed.includes(topicKey);
    }
  }

  _scheduleTopicLeadAfterPlayback(generation) {
    if (
      this.stopped ||
      this._conversationMode === "follow-user" ||
      this._proactiveTurnMode !== PROACTIVE_TURN_CAPABILITY ||
      this._topicLead.paused ||
      this._topicLead.repeatedTopic ||
      this._proactiveRhythm.stopped
    ) {
      if (
        this._proactiveTurnMode === PROACTIVE_TURN_CAPABILITY &&
        (this._topicLead.paused || this._topicLead.repeatedTopic || this._proactiveRhythm.stopped)
      ) this._noteProactiveVeto("cooldown");
      return;
    }
    if (this._proactiveLeadTimer) clearTimeout(this._proactiveLeadTimer);
    if (this._conversationDirector) {
      const scheduled = this._conversationDirector.dispatch({
        type: "playback-completed",
        strategy: this._turnStrategies.get(generation) || null,
      }).find((action) => action.type === "schedule-proactive");
      if (!scheduled) {
        this._noteProactiveVeto("limit");
        return;
      }
      const delay = scheduled.delayMs * this._proactiveRhythm.delayMultiplier;
      this._proactiveLeadTimer = setTimeout(() => {
        this._proactiveLeadTimer = 0;
        if (
          this.stopped ||
          this._topicLead.paused ||
          this._proactiveRhythm.stopped
        ) return this._noteProactiveVeto("cooldown");
        if (this._speechCandidate) return this._noteProactiveVeto("speech");
        if (this._userTurnOpen) return this._noteProactiveVeto("asr");
        if (this._assistantActive) return this._noteProactiveVeto("reply");
        if (this._hasPlayback()) return this._noteProactiveVeto("playback");
        const request = this._conversationDirector.dispatch({
          type: "silence-deadline",
          kind: scheduled.kind,
        }).find((action) => action.type === "request-reply");
        if (!request) return this._noteProactiveVeto("limit");
        if (request.kind === "idle") this._sendTopicTransition(request.strategy);
        else this._sendProactiveTurn(request.kind, request.strategy);
      }, delay);
      return;
    }
    const maxTurns = this._conversationMode === "ai-leads" ? 3 : 1;
    if (this._topicLead.proactiveTurns >= maxTurns) {
      this._noteProactiveVeto("limit");
      return;
    }
    const canSwitchTopic =
      this._conversationMode === "ai-leads" &&
      this._topicLead.lastProactiveKind === "followup" &&
      this._topicLead.topicSwitches < 1;
    const kind = canSwitchTopic ? "idle" : "followup";
    const delay = this._proactiveDelayMs(kind);
    this._proactiveLeadTimer = setTimeout(() => {
      this._proactiveLeadTimer = 0;
      if (
        this.stopped ||
        this._topicLead.paused ||
        this._proactiveRhythm.stopped
      ) return this._noteProactiveVeto("cooldown");
      if (this._speechCandidate) return this._noteProactiveVeto("speech");
      if (this._userTurnOpen) return this._noteProactiveVeto("asr");
      if (this._assistantActive) return this._noteProactiveVeto("reply");
      if (this._hasPlayback()) return this._noteProactiveVeto("playback");
      this._sendProactiveTurn(kind);
    }, delay);
  }

  _proactiveDelayMs(kind) {
    const baseDelay =
      kind === "idle" ? this._proactiveIdleDelayMs : this._proactiveFollowupDelayMs;
    return baseDelay * this._proactiveRhythm.delayMultiplier;
  }

  _maybeScheduleTopicLeadAfterPlayback(generation) {
    if (this._backendAudioPending) {
      this._noteProactiveVeto("receipt");
      return;
    }
    const hasIncompleteSegment = [...this._audioSegments.values()].some(
      (segment) =>
        segment.generation === generation && !segment.dropped && !segment.completed,
    );
    if (hasIncompleteSegment) {
      this._noteProactiveVeto("receipt");
      return;
    }
    this._scheduleTopicLeadAfterPlayback(generation);
  }

  // Prefill timings only reach the trace for providers that report them
  // (local Ollama); cloud turns omit the fields and record nothing.
  _recordPrefillSample(usage) {
    if (!usage || typeof usage !== "object") return;
    const promptEvalMs = usage.promptEvalMs;
    if (!Number.isFinite(promptEvalMs) || promptEvalMs < 0) return;
    const metrics = { promptEvalMs };
    for (const name of ["prompt", "evalMs", "loadMs", "firstTokenWallMs"]) {
      const value = usage[name];
      if (!Number.isFinite(value) || value < 0) continue;
      metrics[name === "prompt" ? "promptTokens" : name] = value;
    }
    // Time the request spent waiting for the shared model before any compute:
    // the proxy's wall clock to first token minus the work the provider admits
    // to. Ollama serialises requests and excludes that wait from its own
    // timings, so without this subtraction the delay is invisible.
    if (Number.isFinite(metrics.firstTokenWallMs)) {
      metrics.queueWaitMs = Math.max(
        0,
        Math.round(
          metrics.firstTokenWallMs - promptEvalMs - (metrics.loadMs || 0),
        ),
      );
    }
    this.trace.record(TRACE_EVENT.LLM_PREFILL, { metrics });
  }

  _clearResponseFinishWatchdog() {
    if (this._responseFinishTimer) clearTimeout(this._responseFinishTimer);
    this._responseFinishTimer = 0;
    this._responseFinishGeneration = null;
    this._responseFinishRecoveryPending = false;
  }

  _armResponseFinishWatchdog(generation) {
    if (
      this._responseFinishMode !== RESPONSE_FINISH_CAPABILITY ||
      !Number.isSafeInteger(generation) ||
      generation !== this._backendGeneration
    ) return;
    this._clearResponseFinishWatchdog();
    this._responseFinishGeneration = generation;
    this._responseFinishTimer = setTimeout(() => {
      this._responseFinishTimer = 0;
      if (
        this.stopped ||
        this._responseFinishRecoveryPending ||
        !this._backendAudioPending ||
        this._assistantActive ||
        this._hasPlayback() ||
        this._currentAudioSegment !== null ||
        [...this._audioSegments.values()].some(
          (segment) => segment.generation === generation && !segment.dropped && !segment.completed,
        ) ||
        generation !== this._backendGeneration ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) return;
      this._responseFinishRecoveryPending = true;
      this._interruptionRecoverySummary.finishStalls = Math.min(
        255,
        this._interruptionRecoverySummary.finishStalls + 1,
      );
      this.ws.send(JSON.stringify({
        type: "response_finish_recover",
        generation,
      }));
    }, this._responseFinishWatchdogMs);
  }

  _onResponseFinishRecovered(msg) {
    if (
      this._responseFinishMode !== RESPONSE_FINISH_CAPABILITY ||
      msg.state !== "recovered" ||
      msg.generation !== this._responseFinishGeneration ||
      msg.generation !== this._backendGeneration
    ) return;
    this._clearResponseFinishWatchdog();
    this._interruptionRecoverySummary.finishRecoveries = Math.min(
      255,
      this._interruptionRecoverySummary.finishRecoveries + 1,
    );
    this._backendAudioPending = false;
    this._assistantActive = false;
    if (!this._hasPlayback()) this._schedulePlaybackCompletion();
  }

  _acceptCandidateSnapshot(message) {
    if (
      this._interruptionHintMode !== INTERRUPTION_HINT_CAPABILITY ||
      message.inProgress !== true
    )
      return;
    const candidateId = message.candidateId;
    const generation = message.generation;
    const segmentId = message.segmentId;
    const playedSamples = message.playedSamples;
    const expectedCandidateId = this._speechCandidate
      ? this._candidateId
      : this._pendingConfirmedCandidate?.candidateId;
    const eligibleSegmentKeys = this._speechCandidate
      ? this._candidateSegmentKeys
      : this._pendingConfirmedCandidate?.segmentKeys;
    if (
      !Number.isSafeInteger(candidateId) ||
      candidateId !== expectedCandidateId ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(segmentId) ||
      segmentId < 1 ||
      segmentId > MAX_AUDIO_SEGMENTS ||
      !Number.isSafeInteger(playedSamples) ||
      playedSamples < 0 ||
      playedSamples > MANAGED_AUDIO_SEGMENT_MAX_SAMPLES
    )
      return;
    const segmentKey = this._segmentKey(generation, segmentId);
    if (!eligibleSegmentKeys?.has(segmentKey)) return;
    const segment = this._audioSegments.get(segmentKey);
    if (segment && (segment.dropped || segment.completed)) return;
    const snapshot = { candidateId, generation, segmentId, playedSamples };
    if (this._speechCandidate) this._candidateSnapshot = snapshot;
    else this._sendInterruptionSnapshot(snapshot);
  }

  _sendInterruptionSnapshot(snapshot) {
    const pending = this._pendingConfirmedCandidate;
    if (
      !pending ||
      pending.candidateId !== snapshot?.candidateId ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    )
      return false;
    this.ws.send(
      JSON.stringify({
        type: "playback_interruption",
        state: "confirmed",
        candidateId: snapshot.candidateId,
        generation: snapshot.generation,
        segmentId: snapshot.segmentId,
        playedSamples: snapshot.playedSamples,
      }),
    );
    if (this._candidateSnapshotTimer) clearTimeout(this._candidateSnapshotTimer);
    this._candidateSnapshotTimer = 0;
    this._pendingConfirmedCandidate = null;
    return true;
  }

  _recordEndpoint(eventType, msg = {}) {
    this.trace.record(eventType, {
      metrics: { silenceMs: Math.max(0, Number(msg.silenceMs) || 0) },
    });
  }

  _acceptBackendGeneration(msg) {
    if (!usesManagedCascade(this.trace.provider) || msg.generation === undefined) return true;
    const generation = msg.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    if (generation < this._backendGeneration) return false;
    if (
      this._interruptedResponseGeneration !== null &&
      generation > this._interruptedResponseGeneration
    ) {
      this._interruptedResponseGeneration = null;
    }
    if (
      this._interruptedResponseGeneration !== null &&
      generation <= this._interruptedResponseGeneration &&
      RESPONSE_OUTPUT_TYPES.has(msg.type)
    ) {
      return false;
    }
    if (
      this._pendingInterruptionRecovery &&
      !this._pendingInterruptionRecovery.started &&
      generation > this._pendingInterruptionRecovery.expectedGeneration &&
      msg.type !== "interruption_recovery_status"
    ) {
      this._cancelInterruptionRecovery();
    }
    this._backendGeneration = generation;
    return true;
  }

  _waitForFinalVadShadowSummary() {
    if (
      !usesManagedCascade(this.trace.provider) ||
      !["shadow-v1", "silero-onnx-shadow-v1"].includes(this._vadShadowMode)
    ) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (received) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._resolveVadShadowFinal === receiveFinal) {
          this._resolveVadShadowFinal = null;
        }
        resolve(received);
      };
      const receiveFinal = () => finish(true);
      const timer = setTimeout(() => finish(false), VAD_SHADOW_FINAL_WAIT_MS);
      this._resolveVadShadowFinal = receiveFinal;
    });
  }

  _segmentKey(generation, segmentId) {
    return `${generation}:${segmentId}`;
  }

  _acceptManagedAudioFrame(frame) {
    if (!frame || frame.generation !== this._backendGeneration) return null;
    const key = this._segmentKey(frame.generation, frame.segmentId);
    const segment = this._audioSegments.get(key);
    const currentKey = this._currentAudioSegment
      ? this._segmentKey(
          this._currentAudioSegment.generation,
          this._currentAudioSegment.segmentId,
        )
      : "";
    if (!segment || key !== currentKey || segment.ended || segment.dropped) return null;
    const streaming = Boolean(segment.streaming);
    if (
      frame.chunkSequence !== segment.nextChunkSequence ||
      segment.receivedSamples + frame.payloadSamples >
        (streaming ? MANAGED_AUDIO_SEGMENT_MAX_SAMPLES : segment.expectedSamples)
    ) {
      this._markSegmentDropped(segment);
      return null;
    }
    segment.nextChunkSequence += 1;
    segment.receivedSamples += frame.payloadSamples;
    return segment;
  }

  _beginAudioSegment(msg) {
    if (!usesManagedCascade(this.trace.provider)) return;
    const generation = msg.generation;
    const segmentId = msg.segmentId;
    const text = typeof msg.text === "string" ? msg.text : "";
    const expectedSamples = msg.samples;
    const managed = this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY;
    const streaming =
      managed &&
      this._ttsStreamingMode === TTS_STREAMING_CAPABILITY &&
      msg.streaming === true;
    if (generation === this._responseFinishGeneration) {
      this._armResponseFinishWatchdog(generation);
    }
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(segmentId) ||
      segmentId < 1 ||
      segmentId > MAX_AUDIO_SEGMENTS ||
      !text ||
      text.length > 256 ||
      (managed &&
        !streaming &&
        (!Number.isSafeInteger(expectedSamples) ||
          expectedSamples < 1 ||
          expectedSamples > MANAGED_AUDIO_SEGMENT_MAX_SAMPLES)) ||
      (streaming && expectedSamples !== undefined)
    ) {
      return;
    }
    const key = this._segmentKey(generation, segmentId);
    if (this._currentAudioSegment) {
      if (!this._currentAudioSegment.dropped) return;
      const dropped = this._currentAudioSegment;
      dropped.ended = true;
      this._deliverAudioSegmentEnd(dropped.generation, dropped.segmentId);
      this._currentAudioSegment = null;
    }
    if (this._audioSegments.has(key)) return;
    if (!this._audioSegments.has(key) && this._audioSegments.size >= MAX_AUDIO_SEGMENTS) {
      const oldest = this._audioSegments.keys().next().value;
      if (oldest !== undefined) this._audioSegments.delete(oldest);
    }
    const segment = {
      generation,
      segmentId,
      text,
      dropped: false,
      completed: false,
      ended: false,
      streaming,
      expectedSamples: managed && !streaming ? expectedSamples : null,
      receivedSamples: 0,
      nextChunkSequence: 0,
    };
    // A valid current-generation segment is authoritative response audio. If a
    // prior candidate/turn left the defensive audio gate closed, reopen it here;
    // otherwise the browser silently discards every PCM frame while the backend
    // continues streaming the completed sentence.
    if (!this._userTurnOpen && generation === this._backendGeneration) {
      this._audioGate = false;
    }
    this._audioSegments.set(key, segment);
    this._currentAudioSegment = segment;
    this.trace.record(TRACE_EVENT.TTS_SEGMENT_STARTED, {
      generationId: generation,
      metrics: { segmentIndex: segmentId },
    });
    this.playbackNode?.port.postMessage({ type: "segment_start", generation, segmentId });
    if (!this.playbackNode) {
      while (!this._legacySegments.has(key) && this._legacySegments.size >= MAX_AUDIO_SEGMENTS) {
        this._legacySegments.delete(this._legacySegments.keys().next().value);
      }
      this._legacySegments.set(key, {
        generation,
        segmentId,
        sources: 0,
        scheduled: 0,
        ended: false,
        cancelled: false,
      });
    }
  }

  _endAudioSegment(msg) {
    const generation = msg.generation;
    const segmentId = msg.segmentId;
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(segmentId)) return;
    const key = this._segmentKey(generation, segmentId);
    if (
      !this._currentAudioSegment ||
      this._segmentKey(
        this._currentAudioSegment.generation,
        this._currentAudioSegment.segmentId,
      ) !== key
    ) {
      return;
    }
    const segment = this._currentAudioSegment;
    segment.ended = true;
    if (this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY) {
      const invalidStreamEnd =
        segment.streaming &&
        (segment.nextChunkSequence < 1 ||
          segment.receivedSamples < 1 ||
          msg.status !== "completed" ||
          !Number.isSafeInteger(msg.samples) ||
          msg.samples !== segment.receivedSamples ||
          !Number.isSafeInteger(msg.chunks) ||
          msg.chunks !== segment.nextChunkSequence);
      const invalidBufferedEnd =
        !segment.streaming &&
        (segment.nextChunkSequence < 1 ||
          segment.receivedSamples !== segment.expectedSamples);
      if (invalidStreamEnd || invalidBufferedEnd) this._markSegmentDropped(segment);
    }
    if (this.audioCtx && this.audioCtx.state !== "running" && this._pendingPcm.length) {
      this._pushPendingPlayback({ type: "segment_end", generation, segmentId });
    } else {
      this._deliverAudioSegmentEnd(generation, segmentId);
    }
    this._currentAudioSegment = null;
  }

  _deliverAudioSegmentEnd(generation, segmentId) {
    const key = this._segmentKey(generation, segmentId);
    this.playbackNode?.port.postMessage({ type: "segment_end", generation, segmentId });
    const legacy = this._legacySegments.get(key);
    if (legacy) {
      legacy.ended = true;
      this._finishLegacySegmentIfReady(key, legacy);
    }
  }

  _markSegmentDropped(segment) {
    if (!segment) return;
    const key = this._segmentKey(segment.generation, segment.segmentId);
    const state = this._audioSegments.get(key);
    if (state) state.dropped = true;
    const legacy = this._legacySegments.get(key);
    if (legacy) legacy.cancelled = true;
  }

  _handleSegmentCompleted(message) {
    const generation = message.generation;
    const segmentId = message.segmentId;
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(segmentId)) return;
    if (usesManagedCascade(this.trace.provider) && generation < this._backendGeneration) return;
    const key = this._segmentKey(generation, segmentId);
    const segment = this._audioSegments.get(key);
    if (!segment || segment.dropped) return;
    if (this._speechCandidate) {
      segment.completed = true;
      return;
    }
    this.trace.record(TRACE_EVENT.PLAYBACK_SEGMENT_COMPLETED, {
      generationId: generation,
      metrics: { segmentIndex: segmentId },
    });
    this._audioSegments.delete(key);
    this._legacySegments.delete(key);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "playback_segment",
          generation,
          segmentId,
          state: "completed",
        }),
      );
    }
    this.cb.onAudibleAssistant?.(segment.text, { generation, segmentId });
    this._pendingUserTurn = false;
    this._noteAudibleTopic(segment.text);
    this._lastAudibleGeneration = generation;
    if (generation === this._responseFinishGeneration) {
      this._armResponseFinishWatchdog(generation);
    }
  }

  _commitDeferredAudioSegments() {
    for (const segment of [...this._audioSegments.values()]) {
      if (segment.completed && !segment.dropped) this._handleSegmentCompleted(segment);
    }
  }

  _finishLegacySegmentIfReady(key, segment) {
    if (
      !segment ||
      segment.cancelled ||
      !segment.ended ||
      segment.scheduled < 1 ||
      segment.sources > 0
    )
      return;
    this._handleSegmentCompleted(segment);
  }

  _notifyPlaybackReset() {
    if (
      !usesManagedCascade(this.trace.provider) ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    )
      return;
    try {
      this.ws.send(JSON.stringify({ type: "playback_reset" }));
    } catch {
      /* the session cleanup path remains local and bounded */
    }
  }

  _discardPendingAudioSegments() {
    this._currentAudioSegment = null;
    for (const segment of this._audioSegments.values()) segment.dropped = true;
    for (const segment of this._legacySegments.values()) segment.cancelled = true;
    this._audioSegments.clear();
    this._legacySegments.clear();
  }

  _confirmSpeech(msg = {}) {
    if (this._userTurnOpen) return false;
    if (this._proactiveLeadTimer || this._missedProactiveWindowPending) {
      this._conversationDirector?.dispatch({ type: "proactive-window-missed", reason: "asr" });
    }
    this._missedProactiveWindowPending = false;
    this._cancelProactiveTimers();
    const interruptsResponse = this._candidateInterruptsResponse;
    const confirmedCandidateId = msg.candidateId;
    const candidateMatches =
      Number.isSafeInteger(confirmedCandidateId) &&
      confirmedCandidateId === this._candidateId;
    const snapshot = candidateMatches ? this._candidateSnapshot : null;
    const segmentKeys = candidateMatches ? this._candidateSegmentKeys : null;
    this._commitProactiveRhythmSignal();
    this._speechCandidate = false;
    this._candidateInterruptsResponse = false;
    this._candidateId = null;
    this._candidateSnapshot = null;
    this._candidateSegmentKeys = null;
    if (candidateMatches) {
      this._pendingConfirmedCandidate = {
        candidateId: confirmedCandidateId,
        segmentKeys,
      };
      if (!snapshot || !this._sendInterruptionSnapshot(snapshot)) {
        this._candidateSnapshotTimer = setTimeout(() => {
          if (this._pendingConfirmedCandidate?.candidateId === confirmedCandidateId) {
            this._pendingConfirmedCandidate = null;
          }
          this._candidateSnapshotTimer = 0;
        }, CANDIDATE_SNAPSHOT_GRACE_MS);
      }
    } else {
      this._resetInterruptionCandidate();
    }
    return this._beginUserTurn(interruptsResponse);
  }

  _rejectSpeech(reason = "voice_rejected") {
    if (!this._speechCandidate) return false;
    this._speechCandidate = false;
    this._missedProactiveWindowPending = false;
    this._pendingProactiveRhythmSignal = null;
    this._candidateInterruptsResponse = false;
    this._resetInterruptionCandidate();
    this.trace.record(TRACE_EVENT.SPEECH_REJECTED, { reason });
    // Rejection means the candidate was not a real user turn. Resume both the
    // Worklet and the transport gate so audio already admitted by the backend,
    // including segments created while ASR was validating the candidate, can
    // continue to playback.
    this._audioGate = false;
    this._resumePlayback();
    this._commitDeferredAudioSegments();
    if (this._lastAudibleGeneration !== null) {
      this._maybeScheduleTopicLeadAfterPlayback(this._lastAudibleGeneration);
    }
    this.cb.onSpeechRejected?.();
    return true;
  }

  _beginUserTurn(candidateInterruptedResponse = false) {
    this._cancelInterruptionRecovery();
    this._clearResponseFinishWatchdog();
    // 仅在「新开一轮」时打断播报；同一轮内的重复 asr_start/asr 不再 flush。
    const alreadyOpen = this._userTurnOpen;
    const assistantWasActive = this._assistantActive;
    const responseWasPending = this.trace.state.response === "active";
    if (
      responseWasPending &&
      this._downlinkAudioMode === MANAGED_AUDIO_CAPABILITY
    ) {
      this._interruptedResponseGeneration = this._backendGeneration;
    }
    this._userTurnOpen = true;
    this._latestFinalAsr = "";
    this._pendingUserTurn = false;
    this._assistantActive = false;
    this._backendAudioPending = false;
    if (alreadyOpen) return false;
    const interruptsResponse =
      candidateInterruptedResponse || assistantWasActive || this._hasPlayback();
    if ((interruptsResponse || responseWasPending) && this.trace.responseId) {
      this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: "turn_detected" });
    }
    if (interruptsResponse) this._audioGate = true;
    // Flush while the previous generation is still current. Otherwise opening
    // the new turn first tags playback_stopped with the new generation even
    // though it is the previous response that was actually cleared.
    this._flushPlayback("turn_detected");
    this.trace.openTurn(TRACE_EVENT.SPEECH_CONFIRMED);
    this._traceAsrFinalSeen = false;
    this._bargeInTurn = true;
    this._confirmedInterruptionEligible = interruptsResponse;
    return true;
  }

  _hasPlayback() {
    return (
      this._playbackQueuedMs > 0 ||
      (this._sources && this._sources.size > 0) ||
      this._pendingPcm.length > 0
    );
  }

  async _startPlayback() {
    const ctx = this.audioCtx;
    if (!ctx || this.playbackNode || this.stopped) return;
    if (!recoverablePlaybackEnabled()) {
      this._playbackMode = "legacy";
      return;
    }
    try {
      await ctx.audioWorklet.addModule("./ai/playback-worklet.js");
      if (this.stopped || !this.audioCtx) return;
      const node = new AudioWorkletNode(ctx, "pcm-playback", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          sourceRate: OUTPUT_RATE,
          maxQueueMs: PLAYBACK_MAX_QUEUE_MS,
          startupBufferMs: 0,
        },
      });
      node.connect(this._outGain || ctx.destination);
      node.port.onmessage = (event) => this._onPlaybackMessage(event.data || {});
      this.playbackNode = node;
      this._playbackMode = "worklet";
      this._flushPendingPcm();
    } catch (error) {
      // Unsupported/failed worklet keeps the established source-node path available.
      console.warn("[realtime] playback worklet unavailable; using legacy scheduler", error);
      this._playbackMode = "legacy";
    }
  }

  _onPlaybackMessage(message) {
    if (Number.isFinite(message.queuedMs)) this._playbackQueuedMs = message.queuedMs;
    if (message.type === "queued" && this._playbackDrainTimer) {
      clearTimeout(this._playbackDrainTimer);
      this._playbackDrainTimer = 0;
    }
    if (message.type === "candidate_snapshot") {
      this._acceptCandidateSnapshot(message);
    } else if (message.type === "segment_completed") {
      this._handleSegmentCompleted(message);
    } else if (message.type === "segment_started") {
      const generation = message.generation;
      const segmentId = message.segmentId;
      if (
        Number.isSafeInteger(generation) &&
        Number.isSafeInteger(segmentId) &&
        this._audioSegments.has(this._segmentKey(generation, segmentId))
      ) {
        this.trace.record(TRACE_EVENT.PLAYBACK_SEGMENT_STARTED, {
          generationId: generation,
          metrics: { segmentIndex: segmentId },
        });
      }
    } else if (message.type === "started") {
      this.trace.recordOnce("playback_started", TRACE_EVENT.PLAYBACK_STARTED, {
        metrics: { queuedMs: this._playbackQueuedMs },
      });
    } else if (message.type === "drained") {
      this._playbackQueuedMs = 0;
      this._schedulePlaybackCompletion();
    } else if (message.type === "level") {
      const rms = Number(message.rms);
      this._playLevel = Number.isFinite(rms) ? Math.min(1, Math.max(0, rms)) : 0;
    }
    if (message.type === "stats") {
      const stats = {
        queuedMs: Number(message.queuedMs) || 0,
        underruns: Number(message.underruns) || 0,
        droppedSamples: Number(message.droppedSamples) || 0,
        playedSamples: Number(message.playedSamples) || 0,
      };
      this.trace.record(TRACE_EVENT.PLAYBACK_STATS, { metrics: stats });
      this.cb.onPlaybackStats?.(stats);
    }
  }

  _duckPlayback() {
    this.playbackNode?.port.postMessage({ type: "duck" });
  }

  _resumePlayback() {
    this.playbackNode?.port.postMessage({ type: "resume" });
  }

  _schedulePlaybackCompletion() {
    if (this._playbackDrainTimer) clearTimeout(this._playbackDrainTimer);
    this._playbackDrainTimer = setTimeout(() => {
      this._playbackDrainTimer = 0;
      if (
        this.stopped ||
        this._backendAudioPending ||
        this._playbackQueuedMs > 0 ||
        this._sources?.size
      )
        return;
      this._assistantActive = false;
      this.trace.recordOnce("playback_stopped", TRACE_EVENT.PLAYBACK_STOPPED, {
        reason: "completed",
      });
      if (this.trace.state.response === "active") {
        this.trace.recordOnce("response_completed", TRACE_EVENT.RESPONSE_COMPLETED, {
          reason: "completed",
        });
      }
      if (
        Number.isSafeInteger(this._lastAudibleGeneration) &&
        this._lastAudibleGeneration !== this._lastDurableAudibleGeneration
      ) {
        this._lastDurableAudibleGeneration = this._lastAudibleGeneration;
        if (this._assistantDraftGeneration === this._lastAudibleGeneration) {
          this._assistantDraftGeneration = null;
        }
        this.cb.onAudibleResponseComplete?.({
          generation: this._lastAudibleGeneration,
        });
        this._scheduleTopicLeadAfterPlayback(this._lastAudibleGeneration);
      }
    }, PLAYBACK_DRAIN_GRACE_MS);
  }

  _enqueuePcm(arrayBuffer, segment = null) {
    if (!this.audioCtx || this.stopped) return;
    this._assistantActive = true;
    // context 尚未 running：先入队，resume 后再播，避免 start(过去时间) 整段静音。
    if (this.audioCtx.state !== "running") {
      this._pushPendingPlayback({
        type: "audio",
        pcm: arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer,
        segment,
      });
      this._kickResumeOut();
      return;
    }
    this._flushPendingPcm();
    this._enqueuePcmNow(arrayBuffer, segment);
  }

  _pushPendingPlayback(item) {
    if (this._pendingPcm.length >= MAX_PENDING_PCM_CHUNKS) {
      const dropped = this._pendingPcm.shift();
      this._markSegmentDropped(dropped?.segment);
    }
    this._pendingPcm.push(item);
  }

  _kickResumeOut() {
    if (!this.audioCtx || this._resumingOut || this.stopped) return;
    this._resumingOut = true;
    this.audioCtx
      .resume()
      .catch(() => {})
      .finally(() => {
        this._resumingOut = false;
        if (this.stopped || !this.audioCtx) return;
        if (this.audioCtx.state === "running") {
          this.playHead = this.audioCtx.currentTime;
          this._flushPendingPcm();
        }
      });
  }

  _flushPendingPcm() {
    if (!this._pendingPcm.length || !this.audioCtx || this.audioCtx.state !== "running") return;
    const pending = this._pendingPcm;
    this._pendingPcm = [];
    for (const item of pending) {
      if (item.type === "segment_end") {
        this._deliverAudioSegmentEnd(item.generation, item.segmentId);
      } else if (!item.segment?.dropped) {
        this._enqueuePcmNow(item.pcm, item.segment);
      }
    }
  }

  _enqueuePcmNow(arrayBuffer, segment = null) {
    if (segment?.dropped) return;
    if (this._playbackDrainTimer) {
      clearTimeout(this._playbackDrainTimer);
      this._playbackDrainTimer = 0;
    }
    if (this.playbackNode) {
      const pcm = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
      this.playbackNode.port.postMessage(
        {
          type: "audio",
          pcm,
          generation: segment?.generation,
          segmentId: segment?.segmentId,
        },
        [pcm],
      );
      return;
    }
    const i16 = new Int16Array(arrayBuffer);
    if (!i16.length) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const buf = this.audioCtx.createBuffer(1, f32.length, OUTPUT_RATE);
    buf.getChannelData(0).set(f32);
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this._outGain || this.audioCtx.destination);
    // 略加超前量，避免 now 与调度竞态导致首帧被跳过。
    const now = this.audioCtx.currentTime + 0.02;
    if (this.playHead < now) this.playHead = now;
    const segmentKey = segment
      ? this._segmentKey(segment.generation, segment.segmentId)
      : "";
    const legacySegment = segmentKey ? this._legacySegments.get(segmentKey) : null;
    if (legacySegment) {
      legacySegment.sources += 1;
      legacySegment.scheduled += 1;
    }
    (this._sources ||= new Set()).add(src);
    src.onended = () => {
      this._sources?.delete(src);
      if (legacySegment) {
        legacySegment.sources = Math.max(0, legacySegment.sources - 1);
        this._finishLegacySegmentIfReady(segmentKey, legacySegment);
      }
      if (!this._sources?.size) this._schedulePlaybackCompletion();
    };
    src.start(this.playHead);
    this.trace.recordOnce("playback_started", TRACE_EVENT.PLAYBACK_STARTED, {
      metrics: { audioBytes: arrayBuffer.byteLength || 0 },
    });
    this.playHead += buf.duration;
  }

  /** 打断：停掉所有排队中的播放源，重置游标。 */
  _flushPlayback(reason = "session_ended") {
    if (this._playbackDrainTimer) clearTimeout(this._playbackDrainTimer);
    this._playbackDrainTimer = 0;
    this._notifyPlaybackReset();
    if (this._hasPlayback()) {
      this.trace.recordOnce("playback_stopped", TRACE_EVENT.PLAYBACK_STOPPED, {
        reason,
        // Preserve the amount of audio that was still queued immediately
        // before the clear. This is bounded, provider-neutral, and lets a
        // diagnostic distinguish an intentional barge-in clear from a TTS or
        // transport failure without retaining PCM or text.
        metrics: { queuedMs: this._playbackQueuedMs },
      });
    }
    for (const pending of this._pendingPcm) this._markSegmentDropped(pending?.segment);
    this._pendingPcm = [];
    this._discardPendingAudioSegments();
    this._playbackQueuedMs = 0;
    this.playbackNode?.port.postMessage({ type: "clear" });
    if (this._sources) {
      for (const s of this._sources) {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }
      this._sources.clear();
    }
    if (this.audioCtx) this.playHead = this.audioCtx.currentTime;
    this._playLevel = 0;
  }

  // ---- 上行采集：麦克风 → worklet → WS（与播放共用 audioCtx）----
  async _startMic() {
    const pending = this._micPrepare || this._acquireMicStream();
    this._micPrepare = null;
    let stream;
    try {
      stream = await pending;
    } catch (e) {
      const name = e?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error("未获得麦克风权限，请在「系统设置 → 隐私与安全性 → 麦克风」中允许元元桌宠");
      }
      throw e;
    }
    if (this.stopped) {
      stream?.getTracks?.().forEach((t) => t.stop());
      return;
    }
    if (!(stream instanceof MediaStream)) {
      throw new Error("麦克风未就绪，请重试并允许访问麦克风");
    }
    this.micStream = stream;
    const ctx = this.audioCtx;
    if (!ctx) throw new Error("音频上下文未初始化");
    if (ctx.state === "suspended") await ctx.resume();
    if (this.stopped) return;
    await ctx.audioWorklet.addModule("./ai/pcm-worklet.js");
    if (this.stopped) return;
    this.micSource = ctx.createMediaStreamSource(this.micStream);
    this.workletNode = new AudioWorkletNode(ctx, "pcm-capture", {
      processorOptions: { targetRate: TARGET_RATE },
    });
    this.workletNode.port.onmessage = (e) => {
      // e.data 是 Int16 PCM 的 ArrayBuffer，直接上行。
      if (this._transportRecovering) {
        this._micLevel = 0;
        return;
      }
      this.trace.recordOnce("mic_audio_input", TRACE_EVENT.MIC_AUDIO_INPUT, {
        metrics: { audioBytes: e.data?.byteLength || 0 },
      });
      this._noteMicLevel(e.data);
      if (
        this.ws &&
        this.ws.readyState === WebSocket.OPEN &&
        this._sessionStarted &&
        !this._transportRecovering &&
        !this.stopped
      ) {
        this.ws.send(e.data);
      }
    };
    this.micSource.connect(this.workletNode);
    this._micReady = true;
    this._scheduleProactiveWelcome();
    // 不接到 destination，避免把麦克风原声播出去。
  }

  /** 挂断并清理所有资源。 */
  async stop(reason = "hangup") {
    if (this.stopped) return;
    const endReason = CALL_END_REASONS.has(reason) ? reason : "provider_terminal";
    this.stopped = true;
    this._cancelInterruptionRecovery();
    this._clearResponseFinishWatchdog();
    this._conversationDirector?.dispatch({ type: "hangup" });
    this._endThinkingFeedback();
    this._cancelProactiveTimers();
    this._pendingProactiveRhythmSignal = null;
    this._missedProactiveWindowPending = false;
    this._sessionTopicLedger?.stop();
    this._activeImportantTopicKey = "";
    this._proactiveTopicProposals.clear();
    this._backendAudioPending = false;
    if (this._levelRaf) cancelAnimationFrame(this._levelRaf);
    this._levelRaf = 0;
    if (this._playbackDrainTimer) clearTimeout(this._playbackDrainTimer);
    this._playbackDrainTimer = 0;
    this._resetInterruptionCandidate();
    this.cb.onLevel?.(0);
    try {
      this._unsubVol?.();
    } catch {
      /* ignore */
    }
    this._unsubVol = null;
    const finalVadShadowSummary = this._waitForFinalVadShadowSummary();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "hangup" }));
      }
    } catch {
      /* ignore */
    }
    if (this.trace.responseId && this.trace.state.response === "active") {
      this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: endReason });
    }
    this._flushPlayback(endReason);
    this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, { reason: endReason });
    try {
      this._keepAliveOsc?.stop();
    } catch {
      /* ignore */
    }
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._outGain = null;
    try {
      this.workletNode?.disconnect();
      this.playbackNode?.disconnect();
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.micStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    this._micPrepare = null;
    try {
      await this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    await finalVadShadowSummary;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.micStream = null;
    this.audioCtx = null;
    this.workletNode = null;
    this.playbackNode = null;
    this.micSource = null;
  }

  /** 返回隐私安全、固定上限的 trace 快照，供诊断或导出测试夹具。 */
  getTraceSnapshot() {
    return {
      ...this.trace.snapshot(),
      runtime: {
        provider: this.trace.provider,
        playbackMode: this._playbackMode,
        downlinkAudio: this._downlinkAudioMode,
        ttsStream: this._ttsStreamingMode,
        interruptionHint: this._interruptionHintMode,
        interruptionRecovery: this._interruptionRecoveryMode,
        responseFinish: this._responseFinishMode,
        memoryContext: this._memoryContextMode,
        vadShadow: this._vadShadowMode,
        asr: { ...this._asrRuntime },
      },
      vadShadowSummary: { ...this._vadShadowSummary },
      recoverySummary: { ...this._interruptionRecoverySummary },
      turnStrategySummary: {
        moves: { ...this._turnStrategySummary.moves },
        stances: { ...this._turnStrategySummary.stances },
        reasoningPolicies: { ...this._turnStrategySummary.reasoningPolicies },
        responseCues: { ...this._turnStrategySummary.responseCues },
        depths: { ...this._turnStrategySummary.depths },
        sources: { ...this._turnStrategySummary.sources },
      },
      proactiveSummary: {
        mode: this._conversationMode,
        capability: this._proactiveTurnMode,
        paused: this._topicLead.paused,
        rhythmStopped: this._proactiveRhythm.stopped,
        ...this._proactiveSummary,
        triggerKinds: { ...this._proactiveSummary.triggerKinds },
        engagementCategories: { ...this._proactiveSummary.engagementCategories },
        vetoReasons: { ...this._proactiveSummary.vetoReasons },
        conversationMoves: { ...this._proactiveSummary.conversationMoves },
        topicActivity: { ...this._proactiveSummary.topicActivity },
      },
    };
  }
}
