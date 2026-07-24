// Provider-neutral realtime voice observability and deterministic replay.
//
// Privacy boundary: trace events deliberately contain no text, persona, key, URL,
// or PCM. Only stable identifiers, lifecycle labels and allow-listed numeric /
// boolean metrics are retained in a bounded in-memory queue.

export const TRACE_SCHEMA_VERSION = 1;
export const REALTIME_DIAGNOSTIC_SCHEMA_VERSION = 2;

const MAX_DIAGNOSTIC_EVENTS = 256;
const MAX_LATENCY_SUMMARIES = 8;

export const TRACE_EVENT = Object.freeze({
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  MIC_AUDIO_INPUT: "mic_audio_input",
  SPEECH_CANDIDATE: "speech_candidate",
  SPEECH_CONFIRMED: "speech_confirmed",
  SPEECH_REJECTED: "speech_rejected",
  ENDPOINT_SOFT_END: "endpoint_soft_end",
  ENDPOINT_REOPENED: "endpoint_reopened",
  ENDPOINT_COMMITTED: "endpoint_committed",
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
  "silenceMs",
  "playedSamples",
  "maxQueuedMs",
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
  endpointSoftEndBeforeReopenMs: [],
  endpointReopenedMs: [TRACE_EVENT.ENDPOINT_REOPENED],
  endpointSoftEndBeforeCommitMs: [],
  endpointCommittedMs: [TRACE_EVENT.ENDPOINT_COMMITTED],
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

function durationsFromMilestones(milestones) {
  return {
    speechToAsrFinalMs: durationBetween(milestones, "speechConfirmedMs", "asrFinalMs"),
    softEndToReopenedMs: durationBetween(
      milestones,
      "endpointSoftEndBeforeReopenMs",
      "endpointReopenedMs",
    ),
    softEndToCommittedMs: durationBetween(
      milestones,
      "endpointSoftEndBeforeCommitMs",
      "endpointCommittedMs",
    ),
    endpointCommittedToAsrFinalMs: durationBetween(
      milestones,
      "endpointCommittedMs",
      "asrFinalMs",
    ),
    asrToLlmFirstOutputMs: durationBetween(milestones, "asrFinalMs", "llmFirstOutputMs"),
    llmRequestToTtsFirstAudioMs: durationBetween(
      milestones,
      "llmRequestMs",
      "ttsFirstAudioMs",
    ),
    ttsRequestToFirstAudioMs: durationBetween(
      milestones,
      "ttsRequestMs",
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
  };
}

function roundMetric(value) {
  return Math.round(value * 1000) / 1000;
}

function summarizeDistribution(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map(roundMetric)
    .sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null };
  const nearestRank = (percentile) =>
    sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    p50: nearestRank(50),
    p95: nearestRank(95),
  };
}

function summarizeCandidateOutcomes(events) {
  const confirmed = [];
  const rejected = [];
  let pendingAt = null;
  let unmatchedCandidates = 0;
  for (const event of events) {
    if (event.eventType === TRACE_EVENT.SPEECH_CANDIDATE) {
      if (pendingAt !== null) unmatchedCandidates += 1;
      pendingAt = event.timestampMs;
    } else if (
      pendingAt !== null &&
      (event.eventType === TRACE_EVENT.SPEECH_CONFIRMED ||
        event.eventType === TRACE_EVENT.SPEECH_REJECTED)
    ) {
      const duration = event.timestampMs - pendingAt;
      if (duration >= 0) {
        (event.eventType === TRACE_EVENT.SPEECH_CONFIRMED ? confirmed : rejected).push(
          duration,
        );
      }
      pendingAt = null;
    }
  }
  if (pendingAt !== null) unmatchedCandidates += 1;
  return {
    candidateToConfirmedMs: summarizeDistribution(confirmed),
    candidateToRejectedMs: summarizeDistribution(rejected),
    unmatchedCandidates,
  };
}

function maxMetric(events, name) {
  let max = 0;
  let seen = false;
  for (const event of events) {
    const value = event.metrics?.[name];
    if (!Number.isFinite(value) || value < 0) continue;
    max = Math.max(max, value);
    seen = true;
  }
  return seen ? roundMetric(max) : null;
}

/** Derive per-generation phase latency without consulting a wall clock. */
export function summarizeTraceLatency(events, generationId) {
  const safeEvents = Array.isArray(events) ? events : [];
  const targetGeneration = Number.isSafeInteger(generationId)
    ? generationId
    : safeEvents.reduce((max, event) => Math.max(max, event.generationId || 0), 0);
  let summary = emptyLatencySummary(targetGeneration);
  for (const event of safeEvents) {
    if (event.generationId === targetGeneration) {
      summary = updateLatencySummary(summary, event);
    }
  }
  return {
    generationId: targetGeneration,
    milestones: summary.milestones,
    durations: summary.durations,
  };
}

function emptyLatencySummary(generationId) {
  const milestones = Object.fromEntries(
    Object.keys(LATENCY_MILESTONES).map((name) => [name, null]),
  );
  return {
    generationId,
    milestones,
    durations: durationsFromMilestones(milestones),
    lastEndpointSoftEndMs: null,
  };
}

function updateLatencySummary(summary, event) {
  const next = {
    generationId: summary.generationId,
    milestones: { ...summary.milestones },
    lastEndpointSoftEndMs: summary.lastEndpointSoftEndMs,
  };
  if (event.eventType === TRACE_EVENT.ENDPOINT_SOFT_END) {
    next.lastEndpointSoftEndMs = event.timestampMs;
  } else if (
    event.eventType === TRACE_EVENT.ENDPOINT_REOPENED &&
    next.milestones.endpointReopenedMs === null
  ) {
    next.milestones.endpointSoftEndBeforeReopenMs = next.lastEndpointSoftEndMs;
  } else if (
    event.eventType === TRACE_EVENT.ENDPOINT_COMMITTED &&
    next.milestones.endpointCommittedMs === null
  ) {
    next.milestones.endpointSoftEndBeforeCommitMs = next.lastEndpointSoftEndMs;
  }
  for (const [name, eventTypes] of Object.entries(LATENCY_MILESTONES)) {
    if (next.milestones[name] === null && eventTypes.includes(event.eventType)) {
      next.milestones[name] = event.timestampMs;
    }
  }
  next.durations = durationsFromMilestones(next.milestones);
  return next;
}

function safeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function sanitizeAppVersion(value) {
  const version = String(value || "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ? version : null;
}

function sanitizeRuntimeSummary(runtime) {
  const value = runtime && typeof runtime === "object" ? runtime : {};
  return {
    provider: normalizeProvider(value.provider),
    playbackMode: safeEnum(value.playbackMode, ["worklet", "legacy", "none"], "none"),
    downlinkAudio: safeEnum(value.downlinkAudio, ["managed-v1", "raw"], "raw"),
    ttsStream: safeEnum(value.ttsStream, ["provider-pcm-v1", "none"], "none"),
    interruptionHint: safeEnum(
      value.interruptionHint,
      ["candidate-snapshot-v1", "none"],
      "none",
    ),
    vadShadow: safeEnum(
      value.vadShadow,
      ["shadow-v1", "disabled", "unavailable"],
      "disabled",
    ),
  };
}

function sanitizeLatencySummary(summary) {
  if (!summary || !Number.isSafeInteger(summary.generationId) || summary.generationId < 0) {
    return null;
  }
  const milestones = {};
  for (const name of Object.keys(LATENCY_MILESTONES)) {
    const value = summary.milestones?.[name];
    milestones[name] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return {
    generationId: summary.generationId,
    milestones,
    durations: durationsFromMilestones(milestones),
  };
}

/**
 * Re-sanitize a snapshot into the only JSON shape exposed to users.
 * The report never trusts caller-supplied objects and stays bounded even when
 * used with imported fixtures instead of a live RealtimeTrace snapshot.
 */
export function buildRealtimeDiagnosticReport(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const sourceEvents = Array.isArray(source.events) ? source.events : [];
  const candidateEvents = sourceEvents.slice(-MAX_DIAGNOSTIC_EVENTS);
  const events = [];
  const sessionIds = new Map();
  const turnIds = new Map();
  const responseIds = new Map();
  const aliasId = (value, prefix, aliases) => {
    if (!value) return null;
    if (!aliases.has(value)) aliases.set(value, `${prefix}-${aliases.size + 1}`);
    return aliases.get(value);
  };
  let rejectedItems = 0;
  for (const event of candidateEvents) {
    try {
      if (event?.schemaVersion !== TRACE_SCHEMA_VERSION) throw new Error("schema mismatch");
      const safe = createTraceEvent(event);
      events.push(
        createTraceEvent({
          ...safe,
          sessionId: aliasId(safe.sessionId, "session", sessionIds),
          turnId: aliasId(safe.turnId, "turn", turnIds),
          responseId: aliasId(safe.responseId, "response", responseIds),
        }),
      );
    } catch {
      rejectedItems += 1;
    }
  }

  const sourceLatencies = Array.isArray(source.latencies)
    ? source.latencies
    : source.latency
      ? [source.latency]
      : [];
  const latencies = [];
  for (const summary of sourceLatencies.slice(-MAX_LATENCY_SUMMARIES)) {
    const safe = sanitizeLatencySummary(summary);
    if (safe) latencies.push(safe);
    else rejectedItems += 1;
  }

  const sourceDroppedEvents = Number.isSafeInteger(source.droppedEvents)
    ? Math.max(0, source.droppedEvents)
    : 0;
  const coalescedPlaybackStats = Number.isSafeInteger(source.coalescedPlaybackStats)
    ? Math.max(0, source.coalescedPlaybackStats)
    : 0;
  const latency = {};
  for (const name of Object.keys(durationsFromMilestones({}))) {
    latency[name] = summarizeDistribution(
      latencies.map((summary) => summary.durations[name]),
    );
  }
  return {
    diagnosticSchemaVersion: REALTIME_DIAGNOSTIC_SCHEMA_VERSION,
    traceSchemaVersion: TRACE_SCHEMA_VERSION,
    appVersion: sanitizeAppVersion(source.appVersion),
    runtime: sanitizeRuntimeSummary(source.runtime),
    exportStats: {
      sourceDroppedEvents,
      truncatedEvents: Math.max(0, sourceEvents.length - MAX_DIAGNOSTIC_EVENTS),
      rejectedItems,
      coalescedPlaybackStats,
    },
    aggregate: {
      latency,
      interruptions: summarizeCandidateOutcomes(events),
      playback: {
        maxSampledQueuedMs:
          maxMetric(events, "maxQueuedMs") ?? maxMetric(events, "queuedMs"),
        droppedSamples: maxMetric(events, "droppedSamples"),
        playedSamples: maxMetric(events, "playedSamples"),
        drainInclusiveUnderruns: maxMetric(events, "underruns"),
        underrunSemantics: "includes-natural-drain",
      },
    },
    latencies,
    events,
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
    this._latencyByGeneration = new Map();
    this.coalescedPlaybackStats = 0;
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
    this._latencyByGeneration.clear();
    this.coalescedPlaybackStats = 0;
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
    let event = createTraceEvent({
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
    if (event.generationId > 0) {
      if (!this._latencyByGeneration.has(event.generationId)) {
        while (this._latencyByGeneration.size >= MAX_LATENCY_SUMMARIES) {
          this._latencyByGeneration.delete(this._latencyByGeneration.keys().next().value);
        }
        this._latencyByGeneration.set(
          event.generationId,
          emptyLatencySummary(event.generationId),
        );
      }
      this._latencyByGeneration.set(
        event.generationId,
        updateLatencySummary(this._latencyByGeneration.get(event.generationId), event),
      );
    }
    const last = this.events.at(-1);
    if (
      event.eventType === TRACE_EVENT.PLAYBACK_STATS &&
      last?.eventType === TRACE_EVENT.PLAYBACK_STATS &&
      last.generationId === event.generationId
    ) {
      event = createTraceEvent({
        ...event,
        metrics: {
          ...event.metrics,
          maxQueuedMs: Math.max(
            Number(last.metrics.maxQueuedMs) || 0,
            Number(last.metrics.queuedMs) || 0,
            Number(event.metrics.queuedMs) || 0,
          ),
        },
      });
      this.events[this.events.length - 1] = event;
      this.coalescedPlaybackStats += 1;
    } else {
      if (this.events.length >= this.maxEvents) {
        this.events.shift();
        this.droppedEvents += 1;
      }
      this.events.push(event);
    }
    try {
      this.onEvent?.(event, this.state.lastDecision);
    } catch {
      // Observability callbacks must never change the live conversation path.
    }
    return event;
  }

  snapshot() {
    const latencies = [...this._latencyByGeneration.values()].map((summary) => ({
      generationId: summary.generationId,
      milestones: { ...summary.milestones },
      durations: { ...summary.durations },
    }));
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      droppedEvents: this.droppedEvents,
      coalescedPlaybackStats: this.coalescedPlaybackStats,
      events: this.events.slice(),
      latency:
        latencies.find((summary) => summary.generationId === this.generationId) ||
        summarizeTraceLatency(this.events, this.generationId),
      latencies,
      state: { ...this.state, lastDecision: { ...this.state.lastDecision } },
    };
  }
}
