// 实时语音通话控制器（前端）。
//
// 与本地 Rust 桥接（realtime.rs）的私有协议：
//   连上后先发 {type:"start", systemRole, botName}；随后：
//     上行 binary = 麦克风 PCM16 mono 16k（worklet 产出）；
//     下行 binary = 火山/旧服务为 PCM16 mono 24k；本地/Cosy 可协商 managed-v1 envelope；
//     下行 text  = 事件 JSON：
//       {type:"session",state} / {type:"asr_start"} /
//       {type:"speech_candidate|speech_confirmed|speech_rejected"} /
//       {type:"endpoint_soft_end|endpoint_reopened|endpoint_committed",silenceMs} /
//       {type:"asr",text,interim} / {type:"asr_end"} /
//       {type:"assistant",text} / {type:"assistant_end"} / {type:"tts_start|tts_end"} /
//       {type:"audio_segment_start|audio_segment_end",segmentId,...} /
//       {type:"speaking"} / {type:"usage",...} / {type:"error",message}。
//     managed-v1 每个 PCM chunk 自带 generation/segment/chunk identity；binary 不推进 generation。
//     本地级联控制事件可附带单调 generation；低于当前 generation 的迟到事件会被丢弃。
//     上行 text 可含 {type:"playback_segment",generation,segmentId,state:"completed"}；
//     只回执句段标识，不回传文本或 PCM。
//   挂断发 {type:"hangup"}。
//
// 音频采集/播放放前端而非 Rust 的原因：getUserMedia 自带回声消除(AEC)/降噪/AGC，
// 桌宠是外放场景，没有 AEC 会自己听到自己造成啸叫与误打断。

import { getVoiceGain, onVoiceGainChange } from "./voice-volume.js";
import { RealtimeTrace, TRACE_EVENT } from "./realtime-trace.js";

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
const INTERRUPTION_HINT_CAPABILITY = "candidate-snapshot-v1";
const CANDIDATE_ID_MAX = 0xffffffff;
const CANDIDATE_SNAPSHOT_GRACE_MS = 50;

function usesManagedCascade(provider) {
  return provider === "local" || provider === "cosyvoice";
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
    onAudibleAssistant,
    onSpeaking,
    onUsage,
    onLevel,
    onSpeechCandidate,
    onSpeechRejected,
    onPlaybackStats,
    onError,
    provider = "unknown",
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
      onAudibleAssistant,
      onSpeaking,
      onUsage,
      onLevel,
      onSpeechCandidate,
      onSpeechRejected,
      onPlaybackStats,
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
    this._vadShadowMode = "disabled";
    this._candidateId = null;
    this._candidateSnapshot = null;
    this._candidateSegmentKeys = null;
    this._pendingConfirmedCandidate = null;
    this._candidateSnapshotTimer = 0;
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
  async start({ systemRole, botName }) {
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
    await this._openSocket(base, { systemRole, botName });
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
    switch (msg.type) {
      case "session":
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
          this._interruptionHintMode =
            msg.interruptionHint === INTERRUPTION_HINT_CAPABILITY
              ? INTERRUPTION_HINT_CAPABILITY
              : "none";
          this._vadShadowMode =
            msg.vadShadow === undefined
              ? "disabled"
              : ["shadow-v1", "disabled", "unavailable"].includes(msg.vadShadow)
                ? msg.vadShadow
                : "unavailable";
        }
        if (msg.state === "ended") {
          this.trace.recordOnce("session_ended", TRACE_EVENT.SESSION_ENDED, {
            reason: "session_ended",
          });
        }
        this.cb.onState?.(msg.state);
        break;
      case "asr_start":
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
        if (msg.interim === false) this._traceAsrFinalSeen = true;
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
      case "assistant":
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
      case "tts_start":
        this._backendAudioPending = true;
        this.trace.recordOnce("tts_request", TRACE_EVENT.TTS_REQUEST);
        break;
      case "tts_end":
        this._backendAudioPending = false;
        if (!this._hasPlayback()) this._schedulePlaybackCompletion();
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
        if (!this._hasPlayback()) this._schedulePlaybackCompletion();
        if (this.trace.responseId && this.trace.state.response === "active") {
          this.trace.record(TRACE_EVENT.RESPONSE_CANCELLED, { reason: "error" });
        }
        this.cb.onError?.(new Error(msg.message || "实时语音出错"));
        break;
      default:
        break;
    }
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
  }

  _notePlayLevel(arrayBuffer) {
    const r = this._rmsI16(arrayBuffer);
    this._playLevel = Math.max(this._playLevel * 0.55, r);
  }

  _startLevelLoop() {
    const tick = () => {
      if (this.stopped) return;
      // 缓慢衰减，让波形有回落感。
      this._micLevel *= 0.88;
      this._playLevel *= 0.9;
      const level = Math.min(1, Math.max(this._micLevel, this._playLevel) * 2.4);
      this.cb.onLevel?.(level);
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
    if (ctx.state === "suspended") {
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
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
    this.playHead = this.audioCtx.currentTime;
    this._flushPendingPcm();
  }

  _beginSpeechCandidate(msg = {}) {
    if (this._speechCandidate || this._userTurnOpen) return false;
    this._resetInterruptionCandidate();
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
    this._candidateInterruptsResponse = false;
    this._resetInterruptionCandidate();
    this.trace.record(TRACE_EVENT.SPEECH_REJECTED, { reason });
    this._resumePlayback();
    this._commitDeferredAudioSegments();
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
    this.trace.openTurn(TRACE_EVENT.SPEECH_CONFIRMED);
    this._traceAsrFinalSeen = false;
    this._bargeInTurn = true;
    if (interruptsResponse) this._audioGate = true;
    this._flushPlayback("turn_detected");
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
        processorOptions: { sourceRate: OUTPUT_RATE, maxQueueMs: PLAYBACK_MAX_QUEUE_MS },
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
    if (this._hasPlayback()) {
      this.trace.recordOnce("playback_stopped", TRACE_EVENT.PLAYBACK_STOPPED, { reason });
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
    // 不接到 destination，避免把麦克风原声播出去。
  }

  /** 挂断并清理所有资源。 */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
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
        vadShadow: this._vadShadowMode,
      },
    };
  }
}
