// Provider-neutral realtime voice observability and deterministic replay.
//
// Privacy boundary: trace events deliberately contain no text, persona, key, URL,
// or PCM. Only stable identifiers, lifecycle labels and allow-listed numeric /
// boolean metrics are retained in a bounded in-memory queue.

export const TRACE_SCHEMA_VERSION = 1;

export const TRACE_EVENT = Object.freeze({
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  MIC_AUDIO_INPUT: "mic_audio_input",
  SPEECH_CANDIDATE: "speech_candidate",
  SPEECH_CONFIRMED: "speech_confirmed",
  SPEECH_REJECTED: "speech_rejected",
  ASR_PARTIAL: "asr_partial",
  ASR_FINAL: "asr_final",
  LLM_REQUEST: "llm_request",
  LLM_FIRST_TOKEN: "llm_first_token",
  LLM_RESPONSE: "llm_response",
  TTS_REQUEST: "tts_request",
  TTS_FIRST_AUDIO: "tts_first_audio",
  PLAYBACK_QUEUED: "playback_queued",
  PLAYBACK_STARTED: "playback_started",
  PLAYBACK_STATS: "playback_stats",
  PLAYBACK_STOPPED: "playback_stopped",
  RESPONSE_STARTED: "response_started",
  RESPONSE_COMPLETED: "response_completed",
  RESPONSE_CANCELLED: "response_cancelled",
});

const EVENT_TYPES = new Set(Object.values(TRACE_EVENT));
const SAFE_REASONS = new Set([
  "completed",
  "error",
  "hangup",
  "reconnect",
  "session_ended",
  "turn_detected",
  "voice_rejected",
]);
const SAFE_METRICS = new Set([
  "audioBytes",
  "chunkCount",
  "confidence",
  "droppedSamples",
  "interim",
  "queuedMs",
  "playedSamples",
  "underruns",
]);

let fallbackId = 0;

function defaultClock() {
  if (globalThis.performance?.now) return globalThis.performance.now();
  throw new Error("A monotonic clock is required for realtime voice tracing");
}

function defaultId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackId += 1;
  return `${prefix}-${fallbackId}`;
}

function normalizeProvider(provider) {
  const value = String(provider || "unknown").trim().toLowerCase();
  if (value === "cosy") return "cosyvoice";
  return ["volc", "local", "cosyvoice"].includes(value) ? value : "unknown";
}

function normalizeMode(mode, provider) {
  if (mode === "end_to_end" || mode === "cascaded") return mode;
  return provider === "volc" ? "end_to_end" : "cascaded";
}

function sanitizeMetrics(metrics) {
  const safe = {};
  if (!metrics || typeof metrics !== "object") return safe;
  for (const [key, value] of Object.entries(metrics)) {
    if (!SAFE_METRICS.has(key)) continue;
    if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function safeReason(reason) {
  const value = String(reason || "").trim().toLowerCase();
  return SAFE_REASONS.has(value) ? value : null;
}

function safeIdentifier(value, name, required = false) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  const text = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw new Error(`${name} must be an opaque identifier of at most 128 characters`);
  }
  return text;
}

/** Build one immutable v1 trace event. Primarily useful for deterministic tests. */
export function createTraceEvent({
  eventType,
  timestampMs,
  sessionId,
  turnId = null,
  responseId = null,
  generationId = 0,
  provider = "unknown",
  mode,
  reason = null,
  metrics = {},
}) {
  if (!EVENT_TYPES.has(eventType)) throw new Error(`Unknown trace event: ${eventType}`);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error("timestampMs must come from a non-negative monotonic clock");
  }
  if (!Number.isSafeInteger(generationId) || generationId < 0) {
    throw new Error("generationId must be a non-negative safe integer");
  }
  const normalizedProvider = normalizeProvider(provider);
  return Object.freeze({
    schemaVersion: TRACE_SCHEMA_VERSION,
    sessionId: safeIdentifier(sessionId, "sessionId", true),
    turnId: safeIdentifier(turnId, "turnId"),
    responseId: safeIdentifier(responseId, "responseId"),
    generationId,
    timestampMs,
    provider: normalizedProvider,
    mode: normalizeMode(mode, normalizedProvider),
    eventType,
    reason: safeReason(reason),
    metrics: Object.freeze(sanitizeMetrics(metrics)),
  });
}

export function createReplayState() {
  return {
    sessionId: null,
    lifecycle: "idle",
    turnId: null,
    responseId: null,
    generationId: 0,
    speech: "idle",
    response: "idle",
    playback: "idle",
    lastTimestampMs: 0,
    acceptedEvents: 0,
    rejectedEvents: 0,
    lastDecision: { accepted: true, reason: null },
  };
}

function reject(state, reason) {
  return {
    ...state,
    rejectedEvents: state.rejectedEvents + 1,
    lastDecision: { accepted: false, reason },
  };
}

const GENERATION_GATED_EVENTS = new Set([
  TRACE_EVENT.TTS_FIRST_AUDIO,
  TRACE_EVENT.PLAYBACK_QUEUED,
  TRACE_EVENT.PLAYBACK_STARTED,
  TRACE_EVENT.RESPONSE_COMPLETED,
]);

/**
 * Pure reducer used by both runtime observation and fixture replay.
 * It never mutates the input state. Stale session/generation output is rejected
 * in the returned decision; P0 does not use that decision to alter live audio.
 */
export function reduceTraceEvent(state, event) {
  if (!state || !event || event.schemaVersion !== TRACE_SCHEMA_VERSION) {
    return reject(state || createReplayState(), "invalid_event");
  }

  if (event.eventType === TRACE_EVENT.SESSION_STARTED) {
    return {
      ...createReplayState(),
      sessionId: event.sessionId,
      lifecycle: "active",
      generationId: event.generationId,
      lastTimestampMs: event.timestampMs,
      acceptedEvents: state.acceptedEvents + 1,
      rejectedEvents: state.rejectedEvents,
      lastDecision: { accepted: true, reason: null },
    };
  }

  if (state.lifecycle !== "active") return reject(state, "session_inactive");
  if (event.sessionId !== state.sessionId) return reject(state, "session_mismatch");
  if (event.timestampMs < state.lastTimestampMs) return reject(state, "time_regression");
  if (
    GENERATION_GATED_EVENTS.has(event.eventType) &&
    event.generationId < state.generationId
  ) {
    return reject(state, "stale_generation");
  }

  const next = {
    ...state,
    lastTimestampMs: event.timestampMs,
    acceptedEvents: state.acceptedEvents + 1,
    lastDecision: { accepted: true, reason: null },
  };

  switch (event.eventType) {
    case TRACE_EVENT.SESSION_ENDED:
      next.lifecycle = "ended";
      next.speech = "idle";
      next.response = "idle";
      next.playback = "stopped";
      break;
    case TRACE_EVENT.SPEECH_CANDIDATE:
      next.speech = "candidate";
      next.turnId = event.turnId;
      if (next.playback === "started" || next.playback === "queued") {
        next.playback = "paused";
      }
      break;
    case TRACE_EVENT.SPEECH_REJECTED:
      next.speech = "idle";
      if (next.playback === "paused") next.playback = "started";
      break;
    case TRACE_EVENT.SPEECH_CONFIRMED:
      next.speech = "confirmed";
      next.turnId = event.turnId;
      next.generationId = Math.max(next.generationId, event.generationId);
      if (next.playback === "started" || next.playback === "queued") {
        next.playback = "stopped";
      }
      break;
    case TRACE_EVENT.RESPONSE_STARTED:
      next.response = "active";
      next.responseId = event.responseId;
      next.generationId = Math.max(next.generationId, event.generationId);
      break;
    case TRACE_EVENT.RESPONSE_CANCELLED:
      if (!event.responseId || event.responseId === next.responseId) next.response = "cancelled";
      break;
    case TRACE_EVENT.RESPONSE_COMPLETED:
      next.response = "completed";
      next.playback = "stopped";
      break;
    case TRACE_EVENT.PLAYBACK_QUEUED:
      next.playback = "queued";
      break;
    case TRACE_EVENT.PLAYBACK_STARTED:
      next.playback = "started";
      break;
    case TRACE_EVENT.PLAYBACK_STOPPED:
      next.playback = "stopped";
      break;
    default:
      break;
  }
  return next;
}

export function replayTrace(events, initialState = createReplayState()) {
  return events.reduce(reduceTraceEvent, initialState);
}

const LATENCY_MILESTONES = Object.freeze({
  micInputMs: [TRACE_EVENT.MIC_AUDIO_INPUT],
  speechConfirmedMs: [TRACE_EVENT.SPEECH_CONFIRMED],
  asrFinalMs: [TRACE_EVENT.ASR_FINAL],
  llmRequestMs: [TRACE_EVENT.LLM_REQUEST],
  llmFirstOutputMs: [TRACE_EVENT.LLM_FIRST_TOKEN, TRACE_EVENT.LLM_RESPONSE],
  ttsRequestMs: [TRACE_EVENT.TTS_REQUEST],
  ttsFirstAudioMs: [TRACE_EVENT.TTS_FIRST_AUDIO],
  playbackStartedMs: [TRACE_EVENT.PLAYBACK_STARTED],
  responseEndedMs: [TRACE_EVENT.RESPONSE_COMPLETED, TRACE_EVENT.RESPONSE_CANCELLED],
});

function durationBetween(milestones, start, end) {
  const a = milestones[start];
  const b = milestones[end];
  return Number.isFinite(a) && Number.isFinite(b) && b >= a
    ? Math.round((b - a) * 1000) / 1000
    : null;
}

/** Derive per-generation phase latency without consulting a wall clock. */
export function summarizeTraceLatency(events, generationId) {
  const safeEvents = Array.isArray(events) ? events : [];
  const targetGeneration = Number.isSafeInteger(generationId)
    ? generationId
    : safeEvents.reduce((max, event) => Math.max(max, event.generationId || 0), 0);
  const milestones = {};
  for (const [name, eventTypes] of Object.entries(LATENCY_MILESTONES)) {
    const event = safeEvents.find(
      (item) => item.generationId === targetGeneration && eventTypes.includes(item.eventType),
    );
    milestones[name] = event?.timestampMs ?? null;
  }
  return {
    generationId: targetGeneration,
    milestones,
    durations: {
      speechToAsrFinalMs: durationBetween(milestones, "speechConfirmedMs", "asrFinalMs"),
      asrToLlmFirstOutputMs: durationBetween(milestones, "asrFinalMs", "llmFirstOutputMs"),
      llmRequestToTtsFirstAudioMs: durationBetween(
        milestones,
        "llmRequestMs",
        "ttsFirstAudioMs",
      ),
      ttsFirstAudioToPlaybackMs: durationBetween(
        milestones,
        "ttsFirstAudioMs",
        "playbackStartedMs",
      ),
      speechToPlaybackMs: durationBetween(
        milestones,
        "speechConfirmedMs",
        "playbackStartedMs",
      ),
    },
  };
}

/** Bounded runtime collector with monotonic timestamps and safe metadata only. */
export class RealtimeTrace {
  constructor({
    provider,
    mode,
    maxEvents = 256,
    clock = defaultClock,
    idFactory = defaultId,
    onEvent,
  } = {}) {
    this.provider = normalizeProvider(provider);
    this.mode = normalizeMode(mode, this.provider);
    this.maxEvents = Math.max(16, Math.min(4096, Number(maxEvents) || 256));
    this.clock = clock;
    this.idFactory = idFactory;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.events = [];
    this.droppedEvents = 0;
    this.state = createReplayState();
    this.sessionId = null;
    this.turnId = null;
    this.responseId = null;
    this.generationId = 0;
    this.originMs = 0;
    this._once = new Set();
  }

  startSession() {
    this.sessionId = this.idFactory("session");
    this.turnId = null;
    this.responseId = null;
    this.generationId = 0;
    this.originMs = this.clock();
    this.events = [];
    this.droppedEvents = 0;
    this.state = createReplayState();
    this._once.clear();
    return this.record(TRACE_EVENT.SESSION_STARTED);
  }

  openTurn(eventType = TRACE_EVENT.SPEECH_CONFIRMED, metrics = {}) {
    this.generationId += 1;
    this.turnId = this.idFactory("turn");
    this.responseId = null;
    this._once.clear();
    return this.record(eventType, { metrics });
  }

  startResponse() {
    if (!this.turnId) this.turnId = this.idFactory("turn");
    if (!this.responseId) this.responseId = this.idFactory("response");
    return this.recordOnce("response_started", TRACE_EVENT.RESPONSE_STARTED);
  }

  recordOnce(key, eventType, fields = {}) {
    const scopedKey = `${this.generationId}:${key}`;
    if (this._once.has(scopedKey)) return null;
    this._once.add(scopedKey);
    return this.record(eventType, fields);
  }

  record(eventType, { reason = null, metrics = {}, turnId, responseId, generationId } = {}) {
    if (!this.sessionId) return null;
    const elapsed = Math.max(0, this.clock() - this.originMs);
    const event = createTraceEvent({
      eventType,
      timestampMs: Math.round(elapsed * 1000) / 1000,
      sessionId: this.sessionId,
      turnId: turnId === undefined ? this.turnId : turnId,
      responseId: responseId === undefined ? this.responseId : responseId,
      generationId: generationId === undefined ? this.generationId : generationId,
      provider: this.provider,
      mode: this.mode,
      reason,
      metrics,
    });
    this.state = reduceTraceEvent(this.state, event);
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    this.events.push(event);
    try {
      this.onEvent?.(event, this.state.lastDecision);
    } catch {
      // Observability callbacks must never change the live conversation path.
    }
    return event;
  }

  snapshot() {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      droppedEvents: this.droppedEvents,
      events: this.events.slice(),
      latency: summarizeTraceLatency(this.events, this.generationId),
      state: { ...this.state, lastDecision: { ...this.state.lastDecision } },
    };
  }
}
