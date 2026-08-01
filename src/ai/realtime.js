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
//       {type:"audio_segment_start|audio_segment_end",segmentId,...} /
//       session/asr_end.vadShadowSummary / {type:"vad_shadow_summary",final:true,summary} /
//       {type:"speaking"} / {type:"usage",...} / {type:"error",message}。
//     managed-v1 每个 PCM chunk 自带 generation/segment/chunk identity；binary 不推进 generation。
//     本地级联控制事件可附带单调 generation；低于当前 generation 的迟到事件会被丢弃。
//     上行 text 可含 {type:"playback_segment",generation,segmentId,state:"completed"}；
//     只回执句段标识，不回传文本或 PCM。
//     本地/Cosy 清空播放时可发 {type:"playback_reset"}，清理服务端的有界尾部状态。
//     memoryContext 可协商 session-start-v1；本地/Cosy 还可协商 turn-final-v1，
//     服务端未明确回显时视为 none，不把 ASR final 误当作支持动态 context。
//   挂断发 {type:"hangup"}。
//
// 音频采集/播放放前端而非 Rust 的原因：getUserMedia 自带回声消除(AEC)/降噪/AGC，
// 桌宠是外放场景，没有 AEC 会自己听到自己造成啸叫与误打断。

import { getVoiceGain, onVoiceGainChange } from "./voice-volume.js";
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
const MAX_AUDIO_SEGMENTS = 64;
const MANAGED_AUDIO_CAPABILITY = "managed-v1";
const MANAGED_AUDIO_MAGIC = 0x4b584155; // ASCII KXAU; not a Volcano protocol constant.
const MANAGED_AUDIO_VERSION = 1;
const MANAGED_AUDIO_HEADER_BYTES = 24;
const MANAGED_AUDIO_CHUNK_MAX_SAMPLES = (OUTPUT_RATE * 80) / 1000;
const MANAGED_AUDIO_CHUNKS_PER_SEGMENT_MAX = 750;
const MANAGED_AUDIO_SEGMENT_MAX_SAMPLES = OUTPUT_RATE * 60;
const TTS_STREAMING_CAPABILITY = "provider-pcm-v1";
const STREAMING_PLAYBACK_STARTUP_MS = 240;
const INTERRUPTION_HINT_CAPABILITY = "candidate-snapshot-v1";
const SESSION_MEMORY_CAPABILITY = "session-start-v1";
const TURN_MEMORY_CAPABILITY = "turn-final-v1";
const TEMPORAL_CONTEXT_CAPABILITY = "turn-local-v1";
const PROACTIVE_TURN_CAPABILITY = "local-v1";
const MAX_TURN_MEMORY_ITEMS = 3;
const MAX_TURN_MEMORY_CHARS = 700;
const MAX_INITIAL_HISTORY_MESSAGES = 12;
const MAX_INITIAL_HISTORY_MESSAGE_CHARS = 1024;
const MAX_INITIAL_HISTORY_CHARS = 4096;
const CANDIDATE_ID_MAX = 0xffffffff;
const CANDIDATE_SNAPSHOT_GRACE_MS = 50;
const VAD_SHADOW_FINAL_WAIT_MS = 50;
const MAX_TOPIC_KEY_CHARS = 64;
const MAX_TOPICS_USED = 8;
const PROACTIVE_KINDS = new Set(["welcome", "followup", "idle", "memory", "commitment"]);

const PAUSE_TURN_RE = /^(?:安静(?:一会儿|一下|会儿)?|先别说(?:话)?|不要说(?:话)?|暂停(?:一下)?|停一下|先停一下|让我想想|让我静静|我想静静|等一下|稍等(?:一下)?)$/;
const REDIRECT_TURN_RE = /(?:换个?话题|换一个话题|聊点别的|聊别的|别聊这个|不聊这个|说点别的|跳过这个|不说这个)/;
const RESUME_TURN_RE = /^(?:继续(?:说|讲|聊)?(?:吧)?|你继续(?:说|讲|聊)?(?:吧)?|接着(?:说|讲|聊)?(?:吧)?|你说吧|可以继续了|好了继续)$/;
const ACKNOWLEDGE_TURN_RE = /^(?:嗯+|哦+|啊+|好+|好的|行+|明白了?|知道了|原来如此|收到)$/;
const AMUSED_TURN_RE = /^(?:哈{2,}|嘿{2,}|呵{2,}|笑死(?:我了)?|太逗了|有意思|真好笑)$/;
const CURIOUS_TURN_RE = /^(?:是吗|真的(?:啊|吗)?|然后呢|后来呢|还有呢|怎么说|为什么(?:呀|啊)?)$/;
const AGREE_TURN_RE = /^(?:对+|对啊|是的|没错|确实|可不是|我也觉得|有道理)$/;
const ENGAGEMENT_POLICIES = new Set(["acknowledge", "amused", "curious", "agree"]);

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
    selected.push({ role, content });
    totalChars += content.length;
    if (selected.length >= MAX_INITIAL_HISTORY_MESSAGES) break;
  }
  selected.reverse();
  while (selected[0]?.role === "assistant") selected.shift();
  const normalized = [];
  for (const message of selected) {
    const previous = normalized.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      previous.content = Array.from(`${previous.content}\n${message.content}`)
        .slice(0, MAX_INITIAL_HISTORY_MESSAGE_CHARS)
        .join("");
    } else {
      normalized.push(message);
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
    onSpeaking,
    onUsage,
    onLevel,
    onSpeechCandidate,
    onSpeechRejected,
    onMemoryContextRequest,
    onPlaybackStats,
    onResponseError,
    onError,
    provider = "unknown",
    conversationMode = "follow-user",
    proactiveGreetingDelayMs,
    proactiveFollowupDelayMs,
    proactiveIdleDelayMs,
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
      onSpeaking,
      onUsage,
      onLevel,
      onSpeechCandidate,
      onSpeechRejected,
      onMemoryContextRequest,
      onPlaybackStats,
      onResponseError,
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
    this.trace = new RealtimeTrace({ provider, maxEvents: maxTraceEvents, onEvent: onTrace });
    this._backendGeneration = 0;
    this._traceAsrFinalSeen = false;
    this._currentAudioSegment = null;
    this._audioSegments = new Map();
    this._legacySegments = new Map();
    this._downlinkAudioMode = "raw";
    this._ttsStreamingMode = "none";
    this._interruptionHintMode = "none";
    this._memoryContextMode = "none";
    this._temporalContextMode = "none";
    this._memoryContextRequestedAt = 0;
    this._vadShadowMode = "disabled";
    this._asrRuntime = sanitizeAsrRuntime();
    this._vadShadowSummary = sanitizeVadShadowSummary();
    this._resolveVadShadowFinal = null;
    this._candidateId = null;
    this._candidateSnapshot = null;
    this._candidateSegmentKeys = null;
    this._pendingConfirmedCandidate = null;
    this._candidateSnapshotTimer = 0;
    this._conversationMode = ["balanced", "ai-leads"].includes(conversationMode)
      ? conversationMode
      : "follow-user";
    this._proactiveTurnMode = "none";
    this._proactiveTriggerId = 0;
    this._proactiveWelcomeSent = false;
    this._proactiveGreetingTimer = 0;
    this._proactiveLeadTimer = 0;
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
  async start({ systemRole, botName, initialHistory }) {
    this.trace.startSession();
    // 若 chat.js 已在点击栈调用 prepareAudio，这里是幂等补齐。
    this._initAudioCtx();
    if (!this._micPrepare) this._micPrepare = this._acquireMicStream();

    const base = await invoke("get_realtime_base");
    if (this.stopped) return;
    if (!base) throw new Error("实时语音服务未启动");

    await this._resumeAudioCtx();
    if (this.stopped) return;
    await this._startPlayback();
    if (this.stopped) return;
    await this._openSocket(base, { systemRole, botName, initialHistory });
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
      let opened = false;

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
        ws.send(
          JSON.stringify({
            type: "start",
            systemRole: startMsg.systemRole || "",
            botName: startMsg.botName || "元元",
            ...cascadeCapabilities,
          }),
        );
        resolve();
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onerror = () => {
        if (!opened) reject(new Error("连接实时语音服务失败"));
      };
      ws.onclose = () => {
        this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, {
          reason: this.stopped ? "hangup" : "session_ended",
        });
        if (!this.stopped) this.cb.onState?.("ended");
      };
    });
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
      this._notePlayLevel(pcm);
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
            reason: "session_ended",
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
        this._beginSpeechCandidate(msg);
        break;
      case "speech_confirmed":
        if (this._confirmSpeech(msg)) this.cb.onAsrStart?.();
        break;
      case "speech_rejected":
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
            if (this._confirmSpeech()) this.cb.onAsrStart?.();
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
          this._traceAsrFinalSeen = true;
          this._latestFinalAsr = msg.text || "";
          this._applyUserTurnPolicy(classifyRealtimeConversationTurn(this._latestFinalAsr));
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
          this.trace.startResponse();
          this.trace.recordOnce("llm_request", TRACE_EVENT.LLM_REQUEST);
        }
        break;
      }
      case "memory_context_request":
        if (
          this._memoryContextMode === TURN_MEMORY_CAPABILITY &&
          Number.isSafeInteger(msg.generation) &&
          msg.generation === this._backendGeneration
        ) {
          this._memoryContextRequestedAt = performance.now();
          this.trace.record(TRACE_EVENT.MEMORY_CONTEXT_REQUEST);
          this.cb.onMemoryContextRequest?.({
            generation: msg.generation,
            reason: msg.reason === "proactive-topic" ? "proactive-topic" : "turn",
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
        this.trace.startResponse();
        this.trace.recordOnce("llm_first_token", TRACE_EVENT.LLM_FIRST_TOKEN);
        this.cb.onAssistant?.(msg.text || "", { generation: msg.generation });
        break;
      case "assistant_end":
        this._assistantActive = false;
        this.trace.recordOnce("llm_response", TRACE_EVENT.LLM_RESPONSE);
        if (this.trace.mode === "end_to_end") {
          this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        }
        this.cb.onAssistantEnd?.();
        break;
      case "assistant_discarded":
        if (!usesManagedCascade(this.trace.provider)) break;
        this._assistantActive = false;
        this.cb.onAssistantDiscarded?.({ generation: msg.generation });
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
      case "tts_start":
        this._backendAudioPending = true;
        this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        break;
      case "tts_end":
        this._backendAudioPending = false;
        if (!this._hasPlayback()) this._schedulePlaybackCompletion();
        if (this._lastAudibleGeneration !== null) {
          this._maybeScheduleTopicLeadAfterPlayback(this._lastAudibleGeneration);
        }
        break;
      case "audio_segment_start":
        this._beginAudioSegment(msg);
        break;
      case "audio_segment_end":
        this._endAudioSegment(msg);
        break;
      case "speaking":
        this._assistantActive = true;
        this._audioGate = false;
        this.trace.startResponse();
        this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        this.cb.onSpeaking?.();
        break;
      case "usage":
        this.cb.onUsage?.(msg);
        break;
      case "error":
        this._backendAudioPending = false;
        if (this.trace.responseId && this.trace.state.response === "active") {
          this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: "error" });
        }
        if (msg.recoverable === true && usesManagedCascade(this.trace.provider)) {
          this._assistantActive = false;
          this._flushPlayback("response_error");
          const callback = this.cb.onResponseError || this.cb.onError;
          callback?.(new Error(msg.message || "本轮语音处理失败，请继续说话重试"));
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
  sendMemoryContext({ generation, items, temporalContext } = {}) {
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
      this.ws.send(JSON.stringify({
        type: "memory_context",
        generation,
        items: safe,
        ...(temporal ? { temporalContext: temporal } : {}),
      }));
    } catch {
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

  _beginSpeechCandidate(msg = {}) {
    if (this._speechCandidate || this._userTurnOpen) return false;
    this._resetInterruptionCandidate();
    if (this._proactiveGreetingTimer || this._proactiveLeadTimer) {
      this._noteProactiveVeto("speech");
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

  _sendProactiveTurn(kind) {
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
    while (this._proactivePending.size > 8) {
      this._proactivePending.delete(this._proactivePending.keys().next().value);
    }
    this._proactiveSummary.candidates += 1;
    this._proactiveSummary.triggerKinds[kind] += 1;
    this.ws.send(JSON.stringify({ type: "proactive_turn", triggerId, kind }));
    return true;
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
    if (msg.state === "vetoed") {
      this._proactivePending.delete(msg.triggerId);
      this._noteProactiveVeto(msg.reason);
    }
    this._proactiveSummary[msg.state] += 1;
    if (msg.state === "accepted") {
      this._proactivePending.delete(msg.triggerId);
      this._activeProactiveTriggerId = msg.triggerId;
      if (Number.isSafeInteger(msg.generation)) {
        this._activeProactiveGeneration = msg.generation;
        this._activeProactiveFirstAudioAt = 0;
      }
      this._topicLead.proactiveTurns += 1;
      this._topicLead.aiTurnsOnTopic += 1;
      this._topicLead.lastProactiveKind = kind;
      this._topicLead.phase = kind === "idle" ? "opening" : "expanding";
      this._proactiveSummary.proactiveTurns += 1;
      if (kind === "idle") {
        this._rememberTopicKey(this._topicLead.topicKey);
        this._topicLead.topicKey = "";
        this._topicLead.repeatedTopic = false;
        this._topicLead.topicSwitches += 1;
        this._proactiveSummary.topicSwitches += 1;
      }
    }
    if (msg.state === "cancelled") {
      this._proactivePending.delete(msg.triggerId);
      this._activeProactiveTriggerId = null;
      this._activeProactiveGeneration = null;
      this._activeProactiveFirstAudioAt = 0;
    }
  }

  _applyUserTurnPolicy(policy) {
    if (this._proactiveLeadTimer) this._noteProactiveVeto("asr");
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
    this._audioSegments.set(key, segment);
    this._currentAudioSegment = segment;
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
    this._noteAudibleTopic(segment.text);
    this._lastAudibleGeneration = generation;
    this._maybeScheduleTopicLeadAfterPlayback(generation);
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
    this._pendingProactiveRhythmSignal = null;
    this._candidateInterruptsResponse = false;
    this._resetInterruptionCandidate();
    this.trace.record(TRACE_EVENT.SPEECH_REJECTED, { reason });
    this._resumePlayback();
    this._commitDeferredAudioSegments();
    if (this._lastAudibleGeneration !== null) {
      this._maybeScheduleTopicLeadAfterPlayback(this._lastAudibleGeneration);
    }
    this.cb.onSpeechRejected?.();
    return true;
  }

  _beginUserTurn(candidateInterruptedResponse = false) {
    // 仅在「新开一轮」时打断播报；同一轮内的重复 asr_start/asr 不再 flush。
    const alreadyOpen = this._userTurnOpen;
    const assistantWasActive = this._assistantActive;
    this._userTurnOpen = true;
    this._assistantActive = false;
    this._backendAudioPending = false;
    if (alreadyOpen) return false;
    const interruptsResponse =
      candidateInterruptedResponse || assistantWasActive || this._hasPlayback();
    if (interruptsResponse && this.trace.responseId) {
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
    } else if (message.type === "started") {
      this.trace.recordOnce("playback_started", TRACE_EVENT.PLAYBACK_STARTED, {
        metrics: { queuedMs: this._playbackQueuedMs },
      });
    } else if (message.type === "drained") {
      this._playbackQueuedMs = 0;
      this._schedulePlaybackCompletion();
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
      this.trace.recordOnce("mic_audio_input", TRACE_EVENT.MIC_AUDIO_INPUT, {
        metrics: { audioBytes: e.data?.byteLength || 0 },
      });
      this._noteMicLevel(e.data);
      if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.stopped) {
        this.ws.send(e.data);
      }
    };
    this.micSource.connect(this.workletNode);
    this._micReady = true;
    this._scheduleProactiveWelcome();
    // 不接到 destination，避免把麦克风原声播出去。
  }

  /** 挂断并清理所有资源。 */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._cancelProactiveTimers();
    this._pendingProactiveRhythmSignal = null;
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
      this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: "hangup" });
    }
    this._flushPlayback("hangup");
    this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, { reason: "hangup" });
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
        memoryContext: this._memoryContextMode,
        vadShadow: this._vadShadowMode,
        asr: { ...this._asrRuntime },
      },
      vadShadowSummary: { ...this._vadShadowSummary },
      proactiveSummary: {
        mode: this._conversationMode,
        capability: this._proactiveTurnMode,
        paused: this._topicLead.paused,
        rhythmStopped: this._proactiveRhythm.stopped,
        ...this._proactiveSummary,
        triggerKinds: { ...this._proactiveSummary.triggerKinds },
        engagementCategories: { ...this._proactiveSummary.engagementCategories },
        vetoReasons: { ...this._proactiveSummary.vetoReasons },
      },
    };
  }
}
