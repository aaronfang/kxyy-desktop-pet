import test from "node:test";
import assert from "node:assert/strict";

import {
  RealtimeTrace,
  TRACE_EVENT,
  buildRealtimeDiagnosticReport,
  createTraceEvent,
  replayTrace,
  sanitizeVadShadowSummary,
  summarizeMemoryContext,
  summarizeTraceLatency,
} from "../src/ai/realtime-trace.js";

function managedAudioFrame({
  generation = 1,
  segmentId = 1,
  chunkSequence = 0,
  pcm = new Int16Array([1, 2, 3]),
  magic = 0x4b584155,
  version = 1,
  flags = 0,
  headerBytes = 24,
  payloadSamples = pcm.length,
} = {}) {
  const frame = new ArrayBuffer(24 + pcm.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, magic, false);
  view.setUint8(4, version);
  view.setUint8(5, flags);
  view.setUint16(6, headerBytes, false);
  view.setUint32(8, generation, false);
  view.setUint32(12, segmentId, false);
  view.setUint32(16, chunkSequence, false);
  view.setUint32(20, payloadSamples, false);
  new Uint8Array(frame, 24).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return frame;
}

function fixtureEvent(eventType, timestampMs, fields = {}) {
  return createTraceEvent({
    eventType,
    timestampMs,
    sessionId: "session-a",
    generationId: 0,
    provider: "local",
    mode: "cascaded",
    ...fields,
  });
}

function fixtureVadShadowSummary(fields = {}) {
  return {
    schemaVersion: 1,
    configRevision: "silero-v6.2.1-p0700-r0350-c3-r3-e8-m96",
    mode: "silero-onnx-shadow-v1",
    status: "active",
    complete: true,
    outstanding: 0,
    queueCapacity: 1,
    maxQueueDepth: 1,
    offered: 8,
    accepted: 8,
    dropped: 0,
    processedJobs: 8,
    processedFrames: 5,
    staleResults: 0,
    fallbacks: 0,
    faults: 0,
    candidateEvents: 1,
    confirmedEvents: 1,
    rejectedEvents: 0,
    candidateTimeoutEvents: 0,
    endedEvents: 1,
    latencySamples: 8,
    inferenceP50Ms: 1.2344,
    inferenceP95Ms: 2.3456,
    ...fields,
  };
}

test("replays a normal user turn and completed response", () => {
  const events = [
    fixtureEvent(TRACE_EVENT.SESSION_STARTED, 0),
    fixtureEvent(TRACE_EVENT.MIC_AUDIO_INPUT, 5),
    fixtureEvent(TRACE_EVENT.SPEECH_CONFIRMED, 20, { turnId: "turn-1", generationId: 1 }),
    fixtureEvent(TRACE_EVENT.ASR_FINAL, 80, { turnId: "turn-1", generationId: 1 }),
    fixtureEvent(TRACE_EVENT.RESPONSE_STARTED, 85, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.LLM_FIRST_TOKEN, 150, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.TTS_REQUEST, 180, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.TTS_FIRST_AUDIO, 240, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_QUEUED, 245, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_STARTED, 250, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.RESPONSE_COMPLETED, 900, {
      turnId: "turn-1",
      responseId: "response-1",
      generationId: 1,
      reason: "completed",
    }),
  ];

  const state = replayTrace(events);
  assert.equal(state.lifecycle, "active");
  assert.equal(state.turnId, "turn-1");
  assert.equal(state.responseId, "response-1");
  assert.equal(state.response, "completed");
  assert.equal(state.playback, "stopped");
  assert.equal(state.rejectedEvents, 0);

  const latency = summarizeTraceLatency(events, 1);
  assert.deepEqual(latency.durations, {
    speechToAsrFinalMs: 60,
    softEndToReopenedMs: null,
    softEndToCommittedMs: null,
    endpointCommittedToAsrFinalMs: null,
    asrToLlmFirstOutputMs: 70,
    llmRequestToTtsFirstAudioMs: null,
    ttsRequestToFirstAudioMs: 60,
    ttsFirstAudioToPlaybackMs: 10,
    speechToPlaybackMs: 230,
  });
});

test("TTS TTFA remains null when either observable boundary is missing", () => {
  const requestOnly = summarizeTraceLatency(
    [fixtureEvent(TRACE_EVENT.TTS_REQUEST, 100, { generationId: 2 })],
    2,
  );
  const firstAudioOnly = summarizeTraceLatency(
    [fixtureEvent(TRACE_EVENT.TTS_FIRST_AUDIO, 160, { generationId: 2 })],
    2,
  );

  assert.equal(requestOnly.durations.ttsRequestToFirstAudioMs, null);
  assert.equal(firstAudioOnly.durations.ttsRequestToFirstAudioMs, null);
});

test("restores playback after a speech candidate is rejected", () => {
  const state = replayTrace([
    fixtureEvent(TRACE_EVENT.SESSION_STARTED, 0),
    fixtureEvent(TRACE_EVENT.RESPONSE_STARTED, 10, {
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_STARTED, 20, {
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.SPEECH_CANDIDATE, 40, {
      turnId: "turn-candidate",
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.SPEECH_REJECTED, 60, {
      turnId: "turn-candidate",
      responseId: "response-1",
      generationId: 1,
      reason: "voice_rejected",
    }),
  ]);

  assert.equal(state.speech, "idle");
  assert.equal(state.playback, "started");
  assert.equal(state.response, "active");
  assert.equal(state.generationId, 1);
  assert.equal(state.rejectedEvents, 0);
});

test("rejects audio from an old generation after confirmed interruption", () => {
  const events = [
    fixtureEvent(TRACE_EVENT.SESSION_STARTED, 0),
    fixtureEvent(TRACE_EVENT.RESPONSE_STARTED, 10, {
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_STARTED, 20, {
      responseId: "response-1",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.SPEECH_CONFIRMED, 40, {
      turnId: "turn-2",
      generationId: 2,
    }),
    fixtureEvent(TRACE_EVENT.RESPONSE_CANCELLED, 45, {
      turnId: "turn-2",
      responseId: "response-1",
      generationId: 1,
      reason: "turn_detected",
    }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_QUEUED, 50, {
      responseId: "response-1",
      generationId: 1,
      metrics: { audioBytes: 3840 },
    }),
  ];

  const state = replayTrace(events);
  assert.equal(state.generationId, 2);
  assert.equal(state.response, "cancelled");
  assert.equal(state.playback, "stopped");
  assert.equal(state.rejectedEvents, 1);
  assert.deepEqual(state.lastDecision, { accepted: false, reason: "stale_generation" });
});

test("rejects late events from a closed session after reconnect", () => {
  const oldSession = [
    fixtureEvent(TRACE_EVENT.SESSION_STARTED, 0),
    fixtureEvent(TRACE_EVENT.RESPONSE_STARTED, 10, {
      responseId: "old-response",
      generationId: 1,
    }),
    fixtureEvent(TRACE_EVENT.SESSION_ENDED, 20, {
      responseId: "old-response",
      generationId: 1,
      reason: "reconnect",
    }),
  ];
  const newSession = createTraceEvent({
    eventType: TRACE_EVENT.SESSION_STARTED,
    timestampMs: 0,
    sessionId: "session-b",
    generationId: 0,
    provider: "local",
    mode: "cascaded",
  });
  const lateOldAudio = fixtureEvent(TRACE_EVENT.PLAYBACK_QUEUED, 30, {
    responseId: "old-response",
    generationId: 1,
  });
  const newMic = createTraceEvent({
    eventType: TRACE_EVENT.MIC_AUDIO_INPUT,
    timestampMs: 5,
    sessionId: "session-b",
    generationId: 0,
    provider: "local",
    mode: "cascaded",
  });

  const state = replayTrace([...oldSession, newSession, lateOldAudio, newMic]);
  assert.equal(state.sessionId, "session-b");
  assert.equal(state.lifecycle, "active");
  assert.equal(state.responseId, null);
  assert.equal(state.rejectedEvents, 1);
  assert.deepEqual(state.lastDecision, { accepted: true, reason: null });
});

test("runtime collector stays bounded and strips unsafe metadata", () => {
  let now = 100;
  let id = 0;
  const trace = new RealtimeTrace({
    provider: "volc",
    maxEvents: 16,
    clock: () => now++,
    idFactory: (prefix) => `${prefix}-${++id}`,
  });
  trace.startSession();
  for (let i = 0; i < 20; i++) {
    trace.record(TRACE_EVENT.MIC_AUDIO_INPUT, {
      reason: "secret free-form reason",
      metrics: { audioBytes: i, rawPcm: "forbidden", text: "forbidden" },
    });
  }

  const snapshot = trace.snapshot();
  assert.equal(snapshot.events.length, 16);
  assert.equal(snapshot.droppedEvents, 5);
  const last = snapshot.events.at(-1);
  assert.equal(last.reason, null);
  assert.deepEqual(last.metrics, { audioBytes: 19 });
  assert.equal(JSON.stringify(snapshot).includes("forbidden"), false);
});

test("keeps eight generation latency summaries outside the rolling event queue", () => {
  let now = 0;
  let id = 0;
  const trace = new RealtimeTrace({
    provider: "local",
    maxEvents: 16,
    clock: () => now,
    idFactory: (prefix) => `${prefix}-${++id}`,
  });
  trace.startSession();
  for (let generation = 1; generation <= 10; generation++) {
    now += 10;
    trace.openTurn();
    now += 10;
    trace.record(TRACE_EVENT.TTS_REQUEST);
    for (let stat = 0; stat < 20; stat++) {
      now += 1;
      trace.record(TRACE_EVENT.PLAYBACK_STATS, { metrics: { queuedMs: stat } });
    }
    now += 30;
    trace.record(TRACE_EVENT.TTS_FIRST_AUDIO);
  }

  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot.latencies.map((item) => item.generationId), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(snapshot.latencies[0].durations.ttsRequestToFirstAudioMs, 50);
  assert.ok(snapshot.events.length <= 16);
  const playbackStats = snapshot.events.filter(
    (event) => event.eventType === TRACE_EVENT.PLAYBACK_STATS,
  );
  assert.equal(
    new Set(playbackStats.map((event) => event.generationId)).size,
    playbackStats.length,
    "each retained generation should have at most one coalesced playback stat",
  );
  assert.equal(snapshot.coalescedPlaybackStats, 190);
  assert.ok(playbackStats.every((event) => event.metrics.maxQueuedMs === 19));
});

test("diagnostic export is bounded and independently strips unsafe fields", () => {
  const events = [];
  for (let index = 0; index < 260; index++) {
    events.push({
      ...fixtureEvent(TRACE_EVENT.MIC_AUDIO_INPUT, index),
      ...(index === 259
        ? {
            sessionId: "sk-secret-access-token",
            turnId: "persona-kxyy-yuanyuan",
            responseId: "private-path-marker",
          }
        : {}),
      settings: { realtimeAccessKey: "forbidden-secret" },
      text: "forbidden-transcript",
      metrics: { audioBytes: index, rawPcm: "forbidden-pcm" },
    });
  }
  events.push({ schemaVersion: 999, text: "forbidden-invalid" });

  const report = buildRealtimeDiagnosticReport({
    appVersion: "0.2.23",
    droppedEvents: 17,
    coalescedPlaybackStats: 23,
    runtime: {
      provider: "cosy",
      playbackMode: "worklet",
      downlinkAudio: "managed-v1",
      ttsStream: "provider-pcm-v1",
      interruptionHint: "candidate-snapshot-v1",
      memoryContext: "turn-final-v1",
      vadShadow: "silero-onnx-shadow-v1",
      asr: {
        requested: "sensevoice",
        active: "sensevoice-sherpa-onnx",
        status: "active",
        modelPath: "forbidden-model-path",
      },
      url: "forbidden-url",
    },
    vadShadowSummary: fixtureVadShadowSummary({
      secret: "forbidden-shadow-secret",
      rawProbability: [0.1, 0.9],
      transcript: "forbidden-shadow-transcript",
    }),
    proactiveSummary: {
      mode: "ai-leads",
      capability: "local-v1",
      paused: true,
      candidates: 4,
      accepted: 3,
      vetoed: 1,
      cancelled: 2,
      preAudioUserReclaims: 1,
      earlyPlaybackInterruptions: 1,
      proactiveTurns: 3,
      topicSwitches: 1,
      triggerKinds: {
        welcome: 1,
        followup: 2,
        idle: 1,
        secret: "forbidden-trigger-secret",
      },
      engagementCategories: {
        acknowledge: 2,
        amused: 1,
        curious: 3,
        agree: 4,
        transcript: "forbidden-engagement-transcript",
      },
      vetoReasons: {
        speech: 1,
        receipt: 2,
        rawReason: "forbidden-veto-reason",
      },
      rhythmBackoffs: 1,
      rhythmStops: 1,
      rhythmStopped: true,
      topicText: "forbidden-topic",
    },
    events,
    latencies: [summarizeTraceLatency(events, 0)],
    persona: "forbidden-persona",
  });

  assert.equal(report.diagnosticSchemaVersion, 8);

  assert.deepEqual(report.runtime, {
    provider: "cosyvoice",
    playbackMode: "worklet",
    downlinkAudio: "managed-v1",
    ttsStream: "provider-pcm-v1",
    interruptionHint: "candidate-snapshot-v1",
    memoryContext: "turn-final-v1",
    vadShadow: "silero-onnx-shadow-v1",
    asr: {
      requested: "sensevoice",
      active: "sensevoice-sherpa-onnx",
      status: "active",
    },
  });
  assert.deepEqual(report.exportStats, {
    sourceDroppedEvents: 17,
    truncatedEvents: 5,
    rejectedItems: 1,
    coalescedPlaybackStats: 23,
  });
  assert.deepEqual(
    report.aggregate.vadShadow,
    fixtureVadShadowSummary({ inferenceP50Ms: 1.234, inferenceP95Ms: 2.346 }),
  );
  assert.deepEqual(report.aggregate.proactive, {
    mode: "ai-leads",
    capability: "local-v1",
    paused: true,
    candidates: 4,
    accepted: 3,
    vetoed: 1,
    cancelled: 2,
    preAudioUserReclaims: 1,
    earlyPlaybackInterruptions: 1,
    proactiveTurns: 3,
    topicSwitches: 1,
    triggerKinds: {
      welcome: 1,
      followup: 2,
      idle: 1,
      memory: 0,
      commitment: 0,
    },
    engagementCategories: {
      acknowledge: 2,
      amused: 1,
      curious: 3,
      agree: 4,
      pause: 0,
      redirect: 0,
      resume: 0,
      substantive: 0,
      silence: 0,
    },
    vetoReasons: {
      speech: 1,
      asr: 0,
      reply: 0,
      playback: 0,
      receipt: 2,
      cooldown: 0,
      limit: 0,
    },
    rhythm: { backoffs: 1, stops: 1, stopped: true },
  });
  assert.equal(report.appVersion, "0.2.23");
  assert.equal(report.events.length, 255);
  assert.equal(report.events.at(-1).metrics.audioBytes, 259);
  assert.deepEqual(
    {
      sessionId: report.events.at(-1).sessionId,
      turnId: report.events.at(-1).turnId,
      responseId: report.events.at(-1).responseId,
    },
    { sessionId: "session-2", turnId: "turn-1", responseId: "response-1" },
  );
  const json = JSON.stringify(report);
  for (const forbidden of [
    "forbidden-secret",
    "forbidden-transcript",
    "forbidden-pcm",
    "forbidden-url",
    "forbidden-persona",
    "sk-secret-access-token",
    "persona-kxyy-yuanyuan",
    "private-path-marker",
    "forbidden-shadow-secret",
    "forbidden-shadow-transcript",
    "forbidden-trigger-secret",
    "forbidden-engagement-transcript",
    "forbidden-veto-reason",
    "rawProbability",
    "forbidden-model-path",
    "forbidden-topic",
  ]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("memory context diagnostics expose bounded latency and stale/timeout counts only", () => {
  const events = [
    createTraceEvent({
      eventType: TRACE_EVENT.MEMORY_CONTEXT_REQUEST,
      timestampMs: 10,
      sessionId: "session-memory",
      generationId: 1,
    }),
    createTraceEvent({
      eventType: TRACE_EVENT.MEMORY_CONTEXT_RESPONSE,
      timestampMs: 24,
      sessionId: "session-memory",
      generationId: 1,
      metrics: { accepted: true, itemCount: 2, memoryChars: 140, latencyMs: 14 },
    }),
    createTraceEvent({
      eventType: TRACE_EVENT.MEMORY_CONTEXT_REQUEST,
      timestampMs: 40,
      sessionId: "session-memory",
      generationId: 2,
    }),
    createTraceEvent({
      eventType: TRACE_EVENT.MEMORY_CONTEXT_RESPONSE,
      timestampMs: 142,
      sessionId: "session-memory",
      generationId: 2,
      metrics: { accepted: false, timedOut: true, itemCount: 0, memoryChars: 0, latencyMs: 102 },
    }),
    createTraceEvent({
      eventType: TRACE_EVENT.MEMORY_CONTEXT_RESPONSE,
      timestampMs: 160,
      sessionId: "session-memory",
      generationId: 2,
      metrics: { accepted: false, stale: true, itemCount: 0, memoryChars: 0 },
    }),
  ];
  assert.deepEqual(summarizeMemoryContext(events), {
    requested: 2,
    responded: 3,
    accepted: 1,
    timedOut: 1,
    stale: 1,
    latencyMs: { count: 2, p50: 14, p95: 102 },
  });
  const report = buildRealtimeDiagnosticReport({ events });
  assert.deepEqual(report.aggregate.memoryContext, summarizeMemoryContext(events));
  assert.equal(JSON.stringify(report).includes("memoryChars"), true);
  assert.equal(JSON.stringify(report).includes("用户"), false);
});

test("diagnostic export fails closed on unknown runtime capability values", () => {
  const report = buildRealtimeDiagnosticReport({
    runtime: {
      provider: "custom-provider",
      playbackMode: "future-mode",
      downlinkAudio: "future-envelope",
      ttsStream: "future-stream",
      interruptionHint: "future-hint",
      vadShadow: "future-shadow",
      asr: {
        requested: "future-asr",
        active: "future-runtime",
        status: "future-status",
      },
    },
  });
  assert.deepEqual(report.runtime, {
    provider: "unknown",
    playbackMode: "none",
    downlinkAudio: "raw",
    ttsStream: "none",
    interruptionHint: "none",
    memoryContext: "none",
    vadShadow: "disabled",
    asr: {
      requested: "whisper",
      active: "none",
      status: "not-reported",
    },
  });
  assert.deepEqual(report.aggregate.vadShadow, sanitizeVadShadowSummary());
});

test("VAD shadow summary is a fixed bounded whitelist with an explicit legacy fallback", () => {
  assert.deepEqual(sanitizeVadShadowSummary(), {
    schemaVersion: 1,
    configRevision: "none",
    mode: "disabled",
    status: "not-reported",
    complete: false,
    outstanding: 0,
    queueCapacity: 1,
    maxQueueDepth: 0,
    offered: 0,
    accepted: 0,
    dropped: 0,
    processedJobs: 0,
    processedFrames: 0,
    staleResults: 0,
    fallbacks: 0,
    faults: 0,
    candidateEvents: 0,
    confirmedEvents: 0,
    rejectedEvents: 0,
    candidateTimeoutEvents: 0,
    endedEvents: 0,
    latencySamples: 0,
    inferenceP50Ms: null,
    inferenceP95Ms: null,
  });

  const sanitized = sanitizeVadShadowSummary(
    fixtureVadShadowSummary({
      complete: true,
      outstanding: 3,
      maxQueueDepth: 2,
      offered: Number.MAX_SAFE_INTEGER + 1,
      dropped: -1,
      latencySamples: 65,
      inferenceP50Ms: Number.NaN,
      inferenceP95Ms: 2,
      path: "/private/audio.raw",
      persona: "private persona",
      pcm: "raw samples",
    }),
  );
  assert.equal(sanitized.complete, false);
  assert.equal(sanitized.outstanding, 0);
  assert.equal(sanitized.maxQueueDepth, 0);
  assert.equal(sanitized.offered, 0);
  assert.equal(sanitized.dropped, 0);
  assert.equal(sanitized.latencySamples, 0);
  assert.equal(sanitized.inferenceP50Ms, null);
  assert.equal(sanitized.inferenceP95Ms, null);
  const json = JSON.stringify(sanitized);
  for (const forbidden of ["/private", "persona", "pcm", "raw samples"]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("diagnostic report aggregates latency and interruption distributions", () => {
  const latencies = [100, 200, 300].map((ttfa, index) => ({
    generationId: index + 1,
    milestones: {
      endpointSoftEndBeforeCommitMs: 10,
      endpointCommittedMs: 40 + index * 10,
      ttsRequestMs: 1000,
      ttsFirstAudioMs: 1000 + ttfa,
    },
  }));
  const report = buildRealtimeDiagnosticReport({
    latencies,
    events: [
      fixtureEvent(TRACE_EVENT.SPEECH_CANDIDATE, 10, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.SPEECH_CONFIRMED, 40, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.SPEECH_CANDIDATE, 100, { generationId: 2 }),
      fixtureEvent(TRACE_EVENT.SPEECH_REJECTED, 150, { generationId: 2 }),
      fixtureEvent(TRACE_EVENT.PLAYBACK_STATS, 160, {
        generationId: 2,
        metrics: { queuedMs: 220, maxQueuedMs: 480, droppedSamples: 12, underruns: 3 },
      }),
    ],
  });

  assert.deepEqual(report.aggregate.latency.ttsRequestToFirstAudioMs, {
    count: 3,
    p50: 200,
    p95: 300,
  });
  assert.deepEqual(report.aggregate.latency.softEndToCommittedMs, {
    count: 3,
    p50: 40,
    p95: 50,
  });
  assert.deepEqual(report.aggregate.interruptions.candidateToConfirmedMs, {
    count: 1,
    p50: 30,
    p95: 30,
  });
  assert.deepEqual(report.aggregate.interruptions.candidateToRejectedMs, {
    count: 1,
    p50: 50,
    p95: 50,
  });
  assert.deepEqual(report.aggregate.playback, {
    maxSampledQueuedMs: 480,
    droppedSamples: 12,
    playedSamples: null,
    drainInclusiveUnderruns: 3,
    underrunSemantics: "includes-natural-drain",
  });
});

test("endpoint latency pairs commit with the latest soft end after a reopen", () => {
  const latency = summarizeTraceLatency(
    [
      fixtureEvent(TRACE_EVENT.ENDPOINT_SOFT_END, 10, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.ENDPOINT_REOPENED, 25, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.ENDPOINT_SOFT_END, 100, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.ENDPOINT_COMMITTED, 150, { generationId: 1 }),
      fixtureEvent(TRACE_EVENT.ASR_FINAL, 180, { generationId: 1 }),
    ],
    1,
  );
  assert.equal(latency.durations.softEndToReopenedMs, 15);
  assert.equal(latency.durations.softEndToCommittedMs, 50);
  assert.equal(latency.durations.endpointCommittedToAsrFinalMs, 30);
});

test("diagnostic report preserves an end-to-end recovery chain after cancellation", () => {
  const events = [
    fixtureEvent(TRACE_EVENT.RESPONSE_STARTED, 10, {
      generationId: 1,
      responseId: "old-response",
    }),
    fixtureEvent(TRACE_EVENT.RESPONSE_CANCELLED, 20, {
      generationId: 1,
      responseId: "old-response",
      reason: "turn_detected",
    }),
    fixtureEvent(TRACE_EVENT.SPEECH_CONFIRMED, 30, { generationId: 2 }),
    fixtureEvent(TRACE_EVENT.ASR_FINAL, 80, { generationId: 2 }),
    fixtureEvent(TRACE_EVENT.TTS_REQUEST, 100, { generationId: 2 }),
    fixtureEvent(TRACE_EVENT.TTS_FIRST_AUDIO, 180, { generationId: 2 }),
    fixtureEvent(TRACE_EVENT.PLAYBACK_STARTED, 190, { generationId: 2 }),
    fixtureEvent(TRACE_EVENT.RESPONSE_COMPLETED, 500, {
      generationId: 2,
      reason: "completed",
    }),
  ];
  const report = buildRealtimeDiagnosticReport({ events });
  assert.deepEqual(
    report.events.map((event) => [event.generationId, event.eventType]),
    events.map((event) => [event.generationId, event.eventType]),
  );
  assert.equal(report.events[0].responseId, "response-1");
  assert.equal(report.events[1].responseId, "response-1");
});

test("schema rejects text-like identifiers and trace callbacks cannot break recording", () => {
  assert.throws(
    () => fixtureEvent(TRACE_EVENT.SESSION_STARTED, 0, { sessionId: "完整用户文本 不应成为 ID" }),
    /opaque identifier/,
  );

  let now = 0;
  const trace = new RealtimeTrace({
    provider: "local",
    clock: () => now++,
    idFactory: (prefix) => `${prefix}-safe`,
    onEvent: () => {
      throw new Error("diagnostic consumer failed");
    },
  });
  assert.doesNotThrow(() => trace.startSession());
  assert.equal(trace.snapshot().events.length, 1);
});

test("managed audio decoder validates the complete fixed header and payload", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { decodeManagedAudioFrame } = await import("../src/ai/realtime.js");
  const valid = managedAudioFrame({
    generation: 0x01020304,
    segmentId: 7,
    chunkSequence: 9,
    pcm: new Int16Array([-1, 2, 300]),
  });
  const decoded = decodeManagedAudioFrame(valid);
  assert.deepEqual(
    {
      generation: decoded.generation,
      segmentId: decoded.segmentId,
      chunkSequence: decoded.chunkSequence,
      payloadSamples: decoded.payloadSamples,
      pcm: [...new Int16Array(decoded.pcm)],
    },
    {
      generation: 0x01020304,
      segmentId: 7,
      chunkSequence: 9,
      payloadSamples: 3,
      pcm: [-1, 2, 300],
    },
  );

  const invalid = [
    new ArrayBuffer(24),
    valid.slice(0, valid.byteLength - 1),
    managedAudioFrame({ magic: 0 }),
    managedAudioFrame({ version: 2 }),
    managedAudioFrame({ flags: 1 }),
    managedAudioFrame({ headerBytes: 22 }),
    managedAudioFrame({ segmentId: 0 }),
    managedAudioFrame({ chunkSequence: 750 }),
    managedAudioFrame({ payloadSamples: 0 }),
    managedAudioFrame({ payloadSamples: 4 }),
    managedAudioFrame({ pcm: new Int16Array(1921) }),
  ];
  for (const frame of invalid) assert.equal(decodeManagedAudioFrame(frame), null);
});

test("realtime waveform envelope stays finite and bounded for short PCM", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  const pcm = new Int16Array([0x7fff, -0x8000]);

  const envelope = session._pcmEnvelope(pcm.buffer);

  assert.equal(envelope.length, 48);
  assert.equal(envelope.every((value) => Number.isFinite(value)), true);
  assert.equal(envelope.every((value) => value >= 0 && value <= 1), true);
});

test("managed and proactive capabilities are explicitly offered only by eligible cascade clients", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.sent = [];
      this.readyState = 1;
      sockets.push(this);
    }

    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  const { RealtimeSession, sanitizeRealtimeInitialHistory } = await import("../src/ai/realtime.js");

  const local = new RealtimeSession({ provider: "local", conversationMode: "ai-leads" });
  local._playbackMode = "worklet";
  local.playbackNode = { port: { postMessage: () => {} } };
  const freshTopic = {
    sourceName: "Hacker News",
    canonicalUrl: "https://example.com/fresh-topic",
    title: "一条新鲜科技话题",
    publishedAt: "2026-08-08T04:00:00Z",
    fetchedAt: "2026-08-08T05:00:00Z",
    shortText: "来自统一缓存的短资料",
    category: "technology",
  };
  const localOpen = local._openSocket("ws://local", {
    systemRole: "role",
    botName: "元元",
    freshTopics: [freshTopic],
    initialHistory: [
      { role: "user", content: "文字聊天里提到按摩椅" },
      { role: "assistant", content: "那把椅子买回来没怎么用。" },
    ],
  });
  sockets[0].onopen();
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      memoryContext: "turn-final-v1",
      interruptionHint: "candidate-snapshot-v1",
      ttsStream: "provider-pcm-v1",
      proactiveTurn: "local-v1",
      freshTopic: "fresh-topic-v1",
    }),
  });
  await localOpen;
  assert.deepEqual(sockets[0].sent[0].downlinkAudio, ["managed-v1"]);
  assert.deepEqual(sockets[0].sent[0].memoryContext, ["session-start-v1", "turn-final-v1"]);
  assert.deepEqual(sockets[0].sent[0].interruptionHint, ["candidate-snapshot-v1"]);
  assert.deepEqual(sockets[0].sent[0].ttsStream, ["provider-pcm-v1"]);
  assert.deepEqual(sockets[0].sent[0].proactiveTurn, ["local-v1"]);
  assert.equal("freshTopics" in sockets[0].sent[0], false);
  assert.deepEqual(sockets[0].sent[0].initialHistory, [
    { role: "user", content: "文字聊天里提到按摩椅" },
    { role: "assistant", content: "那把椅子买回来没怎么用。" },
  ]);
  assert.deepEqual(
    sanitizeRealtimeInitialHistory([
      { role: "assistant", content: "孤立开头" },
      { role: "user", content: "\u2063幕后触发" },
      ...Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `消息${index}`,
      })),
    ]).length,
    12,
  );
  const longRecoveryHistory = [
    { role: "user", content: "今天你不直播，感觉有点寂寞呀" },
    { role: "assistant", content: "我就在家待着呢。" },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `后续消息${index}`,
    })),
  ];
  const recovered = sanitizeRealtimeInitialHistory(longRecoveryHistory);
  assert.equal(recovered.length, 12);
  assert.equal(recovered[0].content, "今天你不直播，感觉有点寂寞呀");
  const restOnlyRecovery = sanitizeRealtimeInitialHistory([
    { role: "user", content: "元元今天好好休息，别太累" },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `普通后续${index}`,
    })),
  ]);
  assert.equal(
    restOnlyRecovery.some((message) => message.content.includes("好好休息")),
    false,
  );
  const clipOnlyRecovery = sanitizeRealtimeInitialHistory([
    { role: "user", content: "元元今天的直播切片很好看" },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `切片后续${index}`,
    })),
  ]);
  assert.equal(
    clipOnlyRecovery.some((message) => message.content.includes("直播切片")),
    false,
  );
  local.trace.startSession();
  assert.deepEqual(sockets[0].sent[1], {
    type: "fresh_topics",
    items: [freshTopic],
  });
  assert.deepEqual(local.getTraceSnapshot().runtime, {
    provider: "local",
    playbackMode: "worklet",
    downlinkAudio: "managed-v1",
    ttsStream: "provider-pcm-v1",
    interruptionHint: "candidate-snapshot-v1",
    memoryContext: "turn-final-v1",
    vadShadow: "disabled",
    asr: {
      requested: "whisper",
      active: "none",
      status: "not-reported",
    },
  });
  const memoryRequests = [];
  local.cb.onMemoryContextRequest = (request) => memoryRequests.push(request);
  local._onMessage({
    data: JSON.stringify({
      type: "memory_context_request",
      generation: 7,
    }),
  });
  assert.deepEqual(memoryRequests, [{ generation: 7, reason: "turn" }]);
  local._backendGeneration = 7;
  assert.equal(
    local.sendMemoryContext({
      generation: 7,
      items: [{ kind: "fact", text: "记忆线索", confidence: 1 }],
      freshTopics: [freshTopic],
    }),
    true,
  );
  assert.deepEqual(sockets[0].sent.at(-1), {
    type: "memory_context",
    generation: 7,
    items: [{ kind: "fact", text: "记忆线索", uncertain: false, pinned: false }],
    freshTopics: [freshTopic],
  });

  const cosy = new RealtimeSession({ provider: "cosyvoice", conversationMode: "balanced" });
  cosy._playbackMode = "worklet";
  cosy.playbackNode = { port: { postMessage: () => {} } };
  const cosyOpen = cosy._openSocket("ws://cosy", { systemRole: "role", botName: "元元" });
  sockets[1].onopen();
  sockets[1].onmessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });
  await cosyOpen;
  assert.deepEqual(sockets[1].sent[0].downlinkAudio, ["managed-v1"]);
  assert.deepEqual(sockets[1].sent[0].memoryContext, ["session-start-v1", "turn-final-v1"]);
  assert.deepEqual(sockets[1].sent[0].interruptionHint, ["candidate-snapshot-v1"]);
  assert.deepEqual(sockets[1].sent[0].ttsStream, ["provider-pcm-v1"]);
  assert.deepEqual(sockets[1].sent[0].proactiveTurn, ["local-v1"]);

  const legacy = new RealtimeSession({ provider: "local" });
  legacy._playbackMode = "legacy";
  const legacyOpen = legacy._openSocket("ws://legacy", {
    systemRole: "role",
    botName: "元元",
    freshTopics: [freshTopic],
  });
  sockets[2].onopen();
  sockets[2].onmessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "raw",
      memoryContext: "turn-final-v1",
      freshTopic: "none",
    }),
  });
  await legacyOpen;
  assert.deepEqual(sockets[2].sent[0].downlinkAudio, ["managed-v1"]);
  assert.deepEqual(sockets[2].sent[0].memoryContext, ["session-start-v1", "turn-final-v1"]);
  assert.equal("interruptionHint" in sockets[2].sent[0], false);
  assert.equal("ttsStream" in sockets[2].sent[0], false);
  assert.equal("proactiveTurn" in sockets[2].sent[0], false);
  assert.equal("freshTopics" in sockets[2].sent[0], false);
  legacy.trace.startSession();
  legacy._backendGeneration = 7;
  assert.equal(
    legacy.sendMemoryContext({ generation: 7, items: [], freshTopics: [freshTopic] }),
    true,
  );
  assert.equal("freshTopics" in sockets[2].sent.at(-1), false);

  const volcano = new RealtimeSession({ provider: "volcano" });
  const volcanoOpen = volcano._openSocket("ws://volcano", {
    systemRole: "role",
    botName: "元元",
    freshTopics: [freshTopic],
  });
  sockets[3].onopen();
  sockets[3].onmessage({
    data: JSON.stringify({ type: "session", state: "started" }),
  });
  await volcanoOpen;
  assert.equal("downlinkAudio" in sockets[3].sent[0], false);
  assert.equal("interruptionHint" in sockets[3].sent[0], false);
  assert.equal("ttsStream" in sockets[3].sent[0], false);
  assert.equal("proactiveTurn" in sockets[3].sent[0], false);
  assert.equal("initialHistory" in sockets[3].sent[0], false);
  assert.equal("freshTopics" in sockets[3].sent[0], false);
  assert.deepEqual(sockets[3].sent[0].memoryContext, ["session-start-v1"]);
});

test("managed transport reconnects with current history before requesting service recovery", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "ws://local" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({
    provider: "voxcpm",
    getRecoveryHistory: () => [{ role: "user", content: "重连前的历史" }],
  });
  session._pendingUserTurn = true;
  const opening = session._openSocket("ws://local", {
    systemRole: "role",
    botName: "元元",
    initialHistory: [],
  });
  sockets[0].onopen();
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      pendingTurnResume: "pending-turn-resume-v1",
    }),
  });
  await opening;
  sockets[0].onclose();
  for (let i = 0; i < 50 && sockets.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  sockets[1].onmessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      pendingTurnResume: "pending-turn-resume-v1",
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sockets[1].sent[0].initialHistory, [
    { role: "user", content: "重连前的历史" },
  ]);
  assert.deepEqual(sockets[1].sent[1], { type: "resume_pending_turn" });
  session.stopped = true;
});

test("transport recovery does not resume an old trailing user message", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({
    provider: "voxcpm",
    getRecoveryHistory: () => [{ role: "user", content: "旧文字消息" }],
  });
  session._getRealtimeBase = async () => "ws://local";
  session._openSocket = async () => {
    session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
    session._sessionStarted = true;
    session._pendingTurnResumeMode = "pending-turn-resume-v1";
  };

  await session._reopenRecoveredSocket();

  assert.deepEqual(sent, []);
});

test("transport reset clears old generation completion identity after preserving the draft", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const events = [];
  let socketClosed = 0;
  const session = new RealtimeSession({
    provider: "voxcpm",
    onAssistantDiscarded: (meta) => events.push(["discard", meta]),
    onTransportReset: () => events.push(["reset"]),
  });
  session._assistantDraftGeneration = 1;
  session._lastAudibleGeneration = 1;
  session._lastDurableAudibleGeneration = 1;
  session.ws = { close: () => { socketClosed += 1; } };

  session._prepareTransportRecovery();

  assert.deepEqual(events, [
    ["discard", { generation: 1, preserveAudible: true }],
    ["reset"],
  ]);
  assert.equal(session._lastAudibleGeneration, null);
  assert.equal(session._lastDurableAudibleGeneration, null);
  assert.equal(session.ws, null);
  assert.equal(socketClosed, 1);
});

test("managed socket opens only after a validated session handshake", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
    close() {}
  };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "voxcpm" });
  session._sessionHandshakeTimeoutMs = () => 5;
  const opening = session._openSocket("ws://local", { systemRole: "role", botName: "元元" });
  sockets[0].onopen();

  await assert.rejects(opening, /会话握手超时/);
  assert.equal(session._sessionStarted, false);
});

test("replaced socket cannot inject stale control messages", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const assistant = [];
  const session = new RealtimeSession({
    provider: "voxcpm",
    onAssistant: (text) => assistant.push(text),
  });
  const firstOpen = session._openSocket("ws://first", { systemRole: "role", botName: "元元" });
  sockets[0].onopen();
  sockets[0].onmessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });
  await firstOpen;
  const secondOpen = session._openSocket("ws://second", { systemRole: "role", botName: "元元" });
  sockets[1].onopen();
  sockets[1].onmessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });
  await secondOpen;

  sockets[0].onmessage({
    data: JSON.stringify({ type: "assistant", text: "旧连接迟到内容", generation: 0 }),
  });

  assert.deepEqual(assistant, []);
});

test("transport recovery discards an unplayed assistant draft before reconnecting", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const discarded = [];
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({
    provider: "voxcpm",
    onAssistantDiscarded: (meta) => discarded.push(meta),
  });
  session._backendGeneration = 4;
  session._assistantActive = true;
  session._assistantDraftGeneration = 4;

  session._prepareTransportRecovery();

  assert.deepEqual(discarded, [{ generation: 4, preserveAudible: false }]);

  const partiallyAudible = new RealtimeSession({
    provider: "voxcpm",
    onAssistantDiscarded: (meta) => discarded.push(meta),
  });
  partiallyAudible._backendGeneration = 5;
  partiallyAudible._assistantActive = true;
  partiallyAudible._assistantDraftGeneration = 5;
  partiallyAudible._lastAudibleGeneration = 5;
  partiallyAudible._prepareTransportRecovery();
  assert.deepEqual(discarded.at(-1), { generation: 5, preserveAudible: true });
});

test("only VoxCPM provider cleanup timeout can request immediate managed restart", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const requests = [];
  const responseErrors = [];
  const voxcpm = new RealtimeSession({
    provider: "voxcpm",
    onResponseError: (error) => responseErrors.push(error.message),
  });
  voxcpm._recoverTransport = async (options) => requests.push(options);
  voxcpm._onMessage({
    data: JSON.stringify({
      type: "error",
      message: "cleanup timeout",
      recoverable: true,
      restartRequired: true,
    }),
  });
  const local = new RealtimeSession({
    provider: "local",
    onResponseError: (error) => responseErrors.push(error.message),
  });
  local._recoverTransport = async (options) => requests.push(options);
  local._onMessage({
    data: JSON.stringify({
      type: "error",
      message: "ordinary error",
      recoverable: true,
      restartRequired: true,
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [{ restartImmediately: true }]);
  assert.deepEqual(responseErrors, ["ordinary error"]);
});

test("managed transport waits through slow service startup after three reconnect failures", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const states = [];
  const session = new RealtimeSession({
    provider: "voxcpm",
    onState: (state) => states.push(state),
  });
  session._startMessage = { systemRole: "role", botName: "元元", initialHistory: [] };
  session._transportRecoveryDelayMs = () => 0;
  session._voiceServiceRecoveryPollDelayMs = () => 0;
  session._getRealtimeBase = async () => "ws://local";
  let reconnects = 0;
  session._openSocket = async () => {
    reconnects += 1;
    if (reconnects <= 3) throw new Error("not ready");
  };
  let restarts = 0;
  session._requestVoiceServiceRecovery = async () => {
    restarts += 1;
  };
  const serviceStates = ["starting", "starting", "starting", "running"];
  let statusChecks = 0;
  session._checkVoiceService = async () => {
    const state = serviceStates[Math.min(statusChecks, serviceStates.length - 1)];
    statusChecks += 1;
    return { backend: "voxcpm", state };
  };

  await session._recoverTransport();

  assert.equal(reconnects, 4);
  assert.equal(restarts, 1);
  assert.equal(statusChecks, 4);
  assert.deepEqual(states, ["recovering"]);
  assert.equal(session.stopped, false);
});

test("non-Vox managed transport never requests an automatic process restart", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const states = [];
  const session = new RealtimeSession({
    provider: "local",
    onState: (state) => states.push(state),
  });
  session._startMessage = { systemRole: "role", botName: "元元", initialHistory: [] };
  session._transportRecoveryDelayMs = () => 0;
  session._getRealtimeBase = async () => "ws://local";
  session._openSocket = async () => {
    throw new Error("not ready");
  };
  let restarts = 0;
  session._requestVoiceServiceRecovery = async () => {
    restarts += 1;
  };

  await session._recoverTransport();

  assert.equal(restarts, 0);
  assert.deepEqual(states, ["recovering", "ended"]);
});

test("visible chat can resume an interrupted audio context without rebuilding the session", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  let resumed = 0;
  let flushed = 0;
  session.audioCtx = {
    state: "interrupted",
    currentTime: 4,
    async resume() {
      resumed += 1;
      this.state = "running";
    },
  };
  session._flushPendingPcm = () => { flushed += 1; };

  await session.resumeAudio();
  assert.equal(resumed, 1);
  assert.equal(flushed, 1);
  assert.equal(session.playHead, 4);

  session.stopped = true;
  await session.resumeAudio();
  assert.equal(resumed, 1);
  assert.equal(flushed, 1);
});

test("proactive welcome is one-shot, negotiated and cancelled by user speech", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.sent = [];
      this.readyState = 1;
      sockets.push(this);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const open = async (options, started = {}) => {
    const session = new RealtimeSession({ proactiveGreetingDelayMs: 0, ...options });
    session._playbackMode = "worklet";
    session.playbackNode = { port: { postMessage: () => {} } };
    session._micReady = true;
    const pending = session._openSocket("ws://test", { systemRole: "role", botName: "元元" });
    const socket = sockets.at(-1);
    socket.onopen();
    socket.onmessage({
      data: JSON.stringify({
        type: "session",
        state: "started",
        downlinkAudio: "managed-v1",
        ...started,
      }),
    });
    await pending;
    return { session, socket };
  };

  const active = await open(
    { provider: "local", conversationMode: "ai-leads" },
    { proactiveTurn: "local-v1" },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    active.socket.sent.filter((message) => message.type === "proactive_turn"),
    [{ type: "proactive_turn", triggerId: 1, kind: "welcome" }],
  );
  active.session._scheduleProactiveWelcome();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(active.socket.sent.filter((message) => message.type === "proactive_turn").length, 1);
  active.session._onMessage({
    data: JSON.stringify({
      type: "proactive_turn_status",
      triggerId: 1,
      state: "accepted",
      generation: 1,
    }),
  });
  active.session._onMessage({
    data: JSON.stringify({ type: "speech_candidate", candidateId: 1 }),
  });
  active.session._onMessage({
    data: JSON.stringify({
      type: "proactive_turn_status",
      triggerId: 1,
      state: "cancelled",
      generation: 1,
    }),
  });
  active.session._onMessage({
    data: JSON.stringify({ type: "speech_confirmed", candidateId: 1 }),
  });
  assert.equal(active.session.getTraceSnapshot().proactiveSummary.cancelled, 1);
  assert.equal(active.session.getTraceSnapshot().proactiveSummary.preAudioUserReclaims, 1);

  const interrupted = await open(
    { provider: "cosyvoice", conversationMode: "balanced", proactiveGreetingDelayMs: 20 },
    { proactiveTurn: "local-v1" },
  );
  interrupted.session._onMessage({
    data: JSON.stringify({ type: "speech_candidate", candidateId: 1 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    interrupted.socket.sent.filter((message) => message.type === "proactive_turn").length,
    0,
  );

  interrupted.session._playbackQueuedMs = 250;
  interrupted.session._onMessage({
    data: JSON.stringify({
      type: "proactive_turn_status",
      triggerId: 1,
      state: "cancelled",
    }),
  });
  assert.equal(interrupted.session._playbackQueuedMs, 0);

  const oldServer = await open({ provider: "local", conversationMode: "ai-leads" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(oldServer.socket.sent.filter((message) => message.type === "proactive_turn").length, 0);
});

test("realtime proactive policy classifies explicit controls without model inference", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const {
    classifyRealtimeConversationTurn,
    classifyRealtimeSoftIntent,
  } = await import("../src/ai/realtime.js");
  const cases = [
    ["安静一会儿", "pause"], ["先别说话", "pause"], ["暂停一下", "pause"],
    ["让我想想", "pause"], ["我想静静", "pause"], ["稍等一下", "pause"],
    ["你先听我说", "pause"], ["让我先讲完", "pause"],
    ["先不跟你聊了，我先吃了啊", "pause"], ["先吃饭了", "pause"],
    ["我边吃边聊", "substantive"],
    ["换个话题吧", "redirect"], ["聊点别的", "redirect"], ["别聊这个", "redirect"],
    ["跳过这个吧", "redirect"], ["不说这个了", "redirect"],
    ["你继续", "resume"], ["继续说吧", "resume"], ["接着讲", "resume"],
    ["你说吧", "resume"], ["可以继续了", "resume"],
    ["嗯嗯", "acknowledge"], ["哦", "acknowledge"], ["好的", "acknowledge"],
    ["明白了", "acknowledge"], ["原来如此", "acknowledge"],
    ["哈哈哈", "amused"], ["嘿嘿", "amused"], ["笑死我了", "amused"],
    ["太逗了", "amused"], ["真好笑", "amused"],
    ["是吗", "curious"], ["真的啊", "curious"], ["然后呢？", "curious"],
    ["后来呢", "curious"], ["怎么说", "curious"], ["为什么呀", "curious"],
    ["对啊", "agree"], ["是的", "agree"], ["没错", "agree"],
    ["确实", "agree"], ["我也觉得", "agree"], ["有道理", "agree"],
    ["我今天完成了一个新项目", "substantive"], ["", "silence"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyRealtimeConversationTurn(text), expected, text);
  }

  const softCases = [
    ["我想听听你是怎么想的", "invite-opinion"],
    ["你怎么看？", "invite-opinion"],
    ["我也不知道，你觉得我该怎么办", "invite-advice"],
    ["换成你会怎么做", "invite-advice"],
    ["这个可以再深入聊聊", "deepen"],
    ["你多讲一点", "deepen"],
    ["我们聊点轻松的吧", "lighten"],
    ["别说得这么沉重", "lighten"],
    ["你能不能说具体点", "concretize"],
    ["举个例子呢", "concretize"],
    ["你今天怎么看起来很累", "none"],
    ["换个话题", "none"],
  ];
  for (const [text, expected] of softCases) {
    assert.equal(classifyRealtimeSoftIntent(text), expected, text);
  }
});

test("ai-leads schedules bounded plan-aware followups from audible playback", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    conversationMode: "ai-leads",
    proactiveFollowupDelayMs: 0,
    proactiveIdleDelayMs: 0,
  });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._proactiveTurnMode = "local-v1";
  session._proactiveWelcomeSent = true;

  session._proactivePending.set(1, "welcome");
  session._noteProactiveStatus({ triggerId: 1, state: "accepted", generation: 1 });
  session._assistantActive = false;
  session._scheduleTopicLeadAfterPlayback(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.at(-1).kind, "followup");
  assert.deepEqual(sent.at(-1).conversationPlan, {
    move: "expand",
    responseCue: "none",
    stance: "companion",
    depth: 0,
  });

  session._noteProactiveStatus({
    triggerId: sent.at(-1).triggerId,
    state: "accepted",
    generation: 2,
  });
  session._assistantActive = false;
  session._scheduleTopicLeadAfterPlayback(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.at(-1).kind, "followup");
  assert.deepEqual(sent.at(-1).conversationPlan, {
    move: "offer-entry",
    responseCue: "low-burden",
    stance: "companion",
    depth: 0,
  });

  session._noteProactiveStatus({
    triggerId: sent.at(-1).triggerId,
    state: "accepted",
    generation: 3,
  });
  session._assistantActive = false;
  session._scheduleTopicLeadAfterPlayback(3);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.filter((message) => message.type === "proactive_turn").length, 2);
  assert.equal(session.getTraceSnapshot().proactiveSummary.topicSwitches, 0);

  session._applyUserTurnPolicy("pause");
  session._scheduleTopicLeadAfterPlayback(4);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.filter((message) => message.type === "proactive_turn").length, 2);
});

test("balanced allows one proactive turn after user engagement", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    conversationMode: "balanced",
    proactiveFollowupDelayMs: 0,
  });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._proactiveTurnMode = "local-v1";
  session._proactivePending.set(1, "welcome");
  session._noteProactiveStatus({ triggerId: 1, state: "accepted", generation: 1 });
  session._scheduleTopicLeadAfterPlayback(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.filter((message) => message.type === "proactive_turn").length, 0);

  session._applyUserTurnPolicy("substantive");
  session._assistantActive = false;
  session._scheduleTopicLeadAfterPlayback(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "followup");
});

test("ai-leads sends a fixed conversation plan with negotiated turn context", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({ provider: "local", conversationMode: "ai-leads" });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._memoryContextMode = "turn-final-v1";
  session._backendGeneration = 7;
  session._userTurnOpen = true;
  session._onMessage({
    data: JSON.stringify({
      type: "asr",
      text: "我想听听你是怎么想的",
      interim: false,
      generation: 7,
    }),
  });

  assert.equal(session.sendMemoryContext({ generation: 7, items: [] }), true);
  assert.deepEqual(sent.at(-1).conversationPlan, {
    move: "expand",
    responseCue: "none",
    stance: "opinion",
    depth: 0,
  });
  assert.equal(JSON.stringify(sent.at(-1)).includes("我想听听"), false);
});

test("thinking feedback is immediate and offers at most one delayed filler signal per turn", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const phases = [];
  let fillerOffers = 0;
  const session = new RealtimeSession({
    provider: "local",
    thinkingFeedbackDelayMs: 0,
    onThinking: (phase) => phases.push(phase),
    onThinkingFillerOffer: () => { fillerOffers += 1; },
  });
  session.trace.startSession();
  session._userTurnOpen = true;
  session._onMessage({ data: JSON.stringify({ type: "asr_end" }) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(phases, ["reasoning"]);
  assert.equal(fillerOffers, 1);

  session._onMessage({
    data: JSON.stringify({ type: "assistant", text: "第一段", generation: 1 }),
  });
  assert.equal(phases.at(-1), "synthesizing");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fillerOffers, 1);

  session._onMessage({ data: JSON.stringify({ type: "speaking", generation: 1 }) });
  assert.equal(phases.at(-1), "idle");
  session._userTurnOpen = true;
  session._onMessage({ data: JSON.stringify({ type: "asr_end" }) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fillerOffers, 2);
});

test("topic keys are stable bounded session-only identifiers", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { deriveRealtimeTopicKey } = await import("../src/ai/realtime.js");
  assert.equal(deriveRealtimeTopicKey("（开心）最近在学吉他！"), "最近在学吉他");
  assert.equal(deriveRealtimeTopicKey("最近在学吉他。"), "最近在学吉他");
  assert.equal(deriveRealtimeTopicKey("哈"), "");
  assert.ok(deriveRealtimeTopicKey("很长的话题".repeat(30)).length <= 64);
});

test("topic history stays bounded and suppresses a repeated audible topic", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    conversationMode: "ai-leads",
    proactiveFollowupDelayMs: 0,
  });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._proactiveTurnMode = "local-v1";
  for (let index = 0; index < 10; index += 1) session._rememberTopicKey(`话题${index}`);
  assert.deepEqual(session._topicLead.topicsUsed, [
    "话题2", "话题3", "话题4", "话题5", "话题6", "话题7", "话题8", "话题9",
  ]);
  session._topicLead.topicKey = "";
  session._noteAudibleTopic("话题9");
  assert.equal(session._topicLead.repeatedTopic, true);
  session._scheduleTopicLeadAfterPlayback(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.length, 0);
});

test("important topic revisit is a bounded accepted transition and stays out of diagnostics", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({ provider: "local", conversationMode: "ai-leads" });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._proactiveTurnMode = "local-v1";
  session._userTurnOpen = true;
  session._onMessage({
    data: JSON.stringify({
      type: "asr",
      text: "我还没决定要不要换工作，这件事让我很纠结",
      interim: false,
      generation: 1,
    }),
  });

  for (let index = 0; index < 4; index += 1) {
    session._sendTopicTransition({
      move: "expand",
      responseCue: "none",
      stance: "companion",
      depth: 1,
    });
    const message = sent.at(-1);
    assert.equal(message.kind, "idle");
    assert.equal("topicRevisit" in message, false);
    session._noteProactiveStatus({
      triggerId: message.triggerId,
      state: "accepted",
      generation: index + 2,
    });
  }

  session._sendTopicTransition({
    move: "deepen",
    responseCue: "low-burden",
    stance: "companion",
    depth: 2,
  });
  const revisit = sent.at(-1);
  assert.deepEqual(revisit.topicRevisit, {
    category: "decision",
    context: "我还没决定要不要换工作，这件事让我很纠结",
  });
  assert.equal(revisit.kind, "revisit");
  session._noteProactiveStatus({
    triggerId: revisit.triggerId,
    state: "accepted",
    generation: 8,
  });

  const diagnostic = JSON.stringify(session.getTraceSnapshot());
  assert.equal(diagnostic.includes("换工作"), false);
  assert.equal(diagnostic.includes("topicRevisit"), false);
  assert.equal(session._sessionTopicLedger.snapshot().revisited, 1);
});

test("proactive rhythm backs off once, stops after two negative signals, and resumes explicitly", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    conversationMode: "ai-leads",
    proactiveFollowupDelayMs: 1000,
  });
  session.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  session._proactiveTurnMode = "local-v1";
  session.trace.startSession();

  session._proactivePending.set(1, "welcome");
  session._noteProactiveStatus({ triggerId: 1, state: "accepted", generation: 1 });
  session._beginSpeechCandidate({ candidateId: 1 });
  session._rejectSpeech();
  assert.equal(session._proactiveRhythm.negativeSignals, 0);
  session._beginSpeechCandidate({ candidateId: 2 });
  session._confirmSpeech({ candidateId: 2 });
  assert.equal(session._proactiveRhythm.delayMultiplier, 1.5);
  assert.equal(session._proactiveDelayMs("followup"), 1500);
  session._userTurnOpen = false;
  session._noteProactiveStatus({ triggerId: 1, state: "cancelled" });

  session._proactivePending.set(2, "followup");
  session._noteProactiveStatus({ triggerId: 2, state: "accepted", generation: 2 });
  session._activeProactiveFirstAudioAt = performance.now();
  session._beginSpeechCandidate({ candidateId: 3 });
  session._confirmSpeech({ candidateId: 3 });
  assert.equal(session._proactiveRhythm.stopped, true);
  session._userTurnOpen = false;
  session._scheduleTopicLeadAfterPlayback(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.filter((message) => message.type === "proactive_turn").length, 0);

  session._applyUserTurnPolicy("resume");
  assert.equal(session._proactiveRhythm.stopped, false);
  assert.equal(session._proactiveRhythm.delayMultiplier, 1);
  session._activeProactiveGeneration = null;
  session._assistantActive = false;
  session._scheduleTopicLeadAfterPlayback(3);
  assert.notEqual(session._proactiveLeadTimer, 0);
  clearTimeout(session._proactiveLeadTimer);
});

test("topic lead timer starts only after the final audible segment", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({
    provider: "local",
    conversationMode: "ai-leads",
    proactiveFollowupDelayMs: 1000,
  });
  session.ws = { readyState: 1, send: () => {} };
  session._proactiveTurnMode = "local-v1";
  session._backendGeneration = 1;
  session._backendAudioPending = true;
  for (const segmentId of [1, 2]) {
    session._audioSegments.set(`1:${segmentId}`, {
      generation: 1,
      segmentId,
      text: `句段${segmentId}`,
      dropped: false,
      completed: false,
    });
  }
  session._handleSegmentCompleted({ generation: 1, segmentId: 1 });
  assert.equal(session._proactiveLeadTimer, 0);
  session._backendAudioPending = false;
  session._handleSegmentCompleted({ generation: 1, segmentId: 2 });
  assert.notEqual(session._proactiveLeadTimer, 0);
  clearTimeout(session._proactiveLeadTimer);
});

test("streamed managed segments require explicit negotiation and exact final totals", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");

  const createSession = (ttsStream = "provider-pcm-v1") => {
    const commands = [];
    const session = new RealtimeSession({ provider: "cosyvoice" });
    session.playbackNode = { port: { postMessage: (message) => commands.push(message) } };
    session.trace.startSession();
    session._onMessage({
      data: JSON.stringify({
        type: "session",
        state: "started",
        downlinkAudio: "managed-v1",
        ...(ttsStream ? { ttsStream } : {}),
      }),
    });
    return { session, commands };
  };

  const unnegotiatedState = createSession(null);
  assert.deepEqual(unnegotiatedState.commands[0], {
    type: "startup_buffer",
    milliseconds: 0,
  });
  const unnegotiated = unnegotiatedState.session;
  unnegotiated._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "不能放宽旧协议。",
      streaming: true,
    }),
  });
  assert.equal(unnegotiated._currentAudioSegment, null);

  const { session, commands } = createSession();
  assert.deepEqual(commands[0], {
    type: "startup_buffer",
    milliseconds: 240,
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 2,
      segmentId: 1,
      text: "真流式句段。",
      streaming: true,
    }),
  });
  session._onMessage({
    data: managedAudioFrame({
      generation: 2,
      segmentId: 1,
      chunkSequence: 0,
      payloadSamples: 3,
      pcm: new Int16Array([1, 2, 3]),
    }),
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_end",
      generation: 2,
      segmentId: 1,
      status: "completed",
      samples: 3,
      chunks: 1,
    }),
  });
  assert.equal(session._audioSegments.get("2:1").dropped, false);
  assert.deepEqual(
    commands.filter((message) => message.type.startsWith("segment_")),
    [
      { type: "segment_start", generation: 2, segmentId: 1 },
      { type: "segment_end", generation: 2, segmentId: 1 },
    ],
  );

  const empty = createSession().session;
  empty._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 3,
      segmentId: 1,
      text: "空句段也必须丢弃。",
      streaming: true,
    }),
  });
  empty._onMessage({
    data: JSON.stringify({
      type: "audio_segment_end",
      generation: 3,
      segmentId: 1,
      status: "completed",
      samples: 0,
      chunks: 0,
    }),
  });
  assert.equal(empty._audioSegments.get("3:1").dropped, true);

  for (const end of [
    { status: "completed", samples: 2, chunks: 1 },
    { status: "completed", samples: 3, chunks: 2 },
    { status: "failed", samples: 3, chunks: 1 },
  ]) {
    const failed = createSession().session;
    failed._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation: 3,
        segmentId: 1,
        text: "必须丢弃。",
        streaming: true,
      }),
    });
    failed._onMessage({
      data: managedAudioFrame({
        generation: 3,
        segmentId: 1,
        chunkSequence: 0,
        payloadSamples: 3,
        pcm: new Int16Array([1, 2, 3]),
      }),
    });
    failed._onMessage({
      data: JSON.stringify({
        type: "audio_segment_end",
        generation: 3,
        segmentId: 1,
        ...end,
      }),
    });
    assert.equal(failed._audioSegments.get("3:1").dropped, true);
  }
});

test("candidate-bound interruption snapshots send one text-free confirmed receipt", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const commands = [];
  const sent = [];
  const session = new RealtimeSession({ provider: "local" });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.playbackNode = { port: { postMessage: (message) => commands.push(message) } };
  session.trace.startSession();
  session._onMessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      interruptionHint: "candidate-snapshot-v1",
    }),
  });

  const beginSegment = (generation) => {
    session._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation,
        segmentId: 1,
        text: "仅留在本地 ledger 的候选句。",
        samples: 48000,
      }),
    });
    session._assistantActive = true;
    session._playbackQueuedMs = 1000;
  };

  beginSegment(3);
  session._onMessage({
    data: JSON.stringify({ type: "speech_candidate", candidateId: 11 }),
  });
  assert.deepEqual(
    commands.filter((message) => message.type === "candidate_snapshot").at(-1),
    { type: "candidate_snapshot", candidateId: 11 },
  );
  session._onPlaybackMessage({
    type: "candidate_snapshot",
    candidateId: 11,
    generation: 3,
    segmentId: 1,
    playedSamples: 24000,
    inProgress: true,
  });
  session._onMessage({
    data: JSON.stringify({ type: "speech_confirmed", candidateId: 11 }),
  });
  assert.deepEqual(sent.filter((message) => message.type !== "playback_reset"), [
    {
      type: "playback_interruption",
      state: "confirmed",
      candidateId: 11,
      generation: 3,
      segmentId: 1,
      playedSamples: 24000,
    },
  ]);
  assert.equal(JSON.stringify(sent).includes("候选句"), false);
  session._onPlaybackMessage({
    type: "candidate_snapshot",
    candidateId: 11,
    generation: 3,
    segmentId: 1,
    playedSamples: 25000,
    inProgress: true,
  });
  assert.equal(
    sent.filter((message) => message.type !== "playback_reset").length,
    1,
    "one candidate may send at most one receipt",
  );

  session._userTurnOpen = false;
  beginSegment(4);
  session._onMessage({
    data: JSON.stringify({ type: "speech_candidate", candidateId: 12 }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "speech_confirmed", candidateId: 12 }),
  });
  assert.equal(session._audioSegments.size, 0, "confirmation clears hidden text ledger");
  session._onPlaybackMessage({
    type: "candidate_snapshot",
    candidateId: 12,
    generation: 4,
    segmentId: 1,
    playedSamples: 24001,
    inProgress: true,
  });
  assert.equal(
    sent.filter((message) => message.type !== "playback_reset").length,
    2,
    "a snapshot arriving after clear keeps numeric identity only",
  );

  session._userTurnOpen = false;
  beginSegment(5);
  session._onMessage({
    data: JSON.stringify({ type: "speech_candidate", candidateId: 13 }),
  });
  session._audioSegments.get("5:1").dropped = true;
  session._onPlaybackMessage({
    type: "candidate_snapshot",
    candidateId: 13,
    generation: 5,
    segmentId: 1,
    playedSamples: 48000,
    inProgress: true,
  });
  session._onPlaybackMessage({
    type: "candidate_snapshot",
    candidateId: 99,
    generation: 5,
    segmentId: 1,
    playedSamples: 48000,
    inProgress: true,
  });
  session._onMessage({
    data: JSON.stringify({ type: "speech_rejected", candidateId: 13 }),
  });
  assert.equal(
    sent.filter((message) => message.type !== "playback_reset").length,
    2,
    "rejected, dropped and wrong-candidate snapshots never send receipts",
  );
});

test("managed cascade accepts only current ordered identified audio", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const commands = [];
  const session = new RealtimeSession({ provider: "local" });
  session.audioCtx = { state: "suspended", resume: () => new Promise(() => {}) };
  session.playbackNode = { port: { postMessage: (message) => commands.push(message) } };
  session._onMessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
    }),
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 3,
      segmentId: 1,
      text: "有身份的音频。",
      samples: 6,
    }),
  });

  session._onMessage({ data: managedAudioFrame({ generation: 2 }) });
  session._onMessage({ data: managedAudioFrame({ generation: 4 }) });
  session._onMessage({ data: managedAudioFrame({ generation: 3, segmentId: 2 }) });
  session._onMessage({ data: new Int16Array([9, 9, 9]).buffer });
  assert.equal(session._backendGeneration, 3, "binary must never advance generation");
  assert.equal(session._pendingPcm.length, 0);

  session._onMessage({
    data: managedAudioFrame({
      generation: 3,
      segmentId: 1,
      chunkSequence: 0,
      pcm: new Int16Array([1, 2, 3]),
    }),
  });
  session._onMessage({
    data: managedAudioFrame({
      generation: 3,
      segmentId: 1,
      chunkSequence: 1,
      pcm: new Int16Array([4, 5, 6]),
    }),
  });
  assert.equal(session._pendingPcm.length, 2);
  assert.deepEqual(
    session._pendingPcm.map((item) => [...new Int16Array(item.pcm)]),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  );
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 3, segmentId: 1 }),
  });
  assert.equal(session._audioSegments.get("3:1").dropped, false);
  assert.deepEqual(commands.map((message) => message.type), ["startup_buffer", "segment_start"]);
});

test("managed sequence gaps and declared sample mismatch suppress completion receipts", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({ provider: "cosyvoice" });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.audioCtx = { state: "suspended", resume: () => new Promise(() => {}) };
  session.playbackNode = { port: { postMessage: () => {} } };
  session._onMessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });

  const start = (generation, samples) =>
    session._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation,
        segmentId: 1,
        text: "不能进入历史的部分句。",
        samples,
      }),
    });
  start(1, 6);
  session._onMessage({
    data: managedAudioFrame({ generation: 1, chunkSequence: 1 }),
  });
  assert.equal(session._audioSegments.get("1:1").dropped, true);

  start(2, 6);
  session._onMessage({
    data: managedAudioFrame({ generation: 2, pcm: new Int16Array([1, 2, 3]) }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 2, segmentId: 1 }),
  });
  assert.equal(session._audioSegments.get("2:1").dropped, true);
  session._onPlaybackMessage({ type: "segment_completed", generation: 2, segmentId: 1 });
  assert.deepEqual(sent, []);

  start(3, 3);
  session._onMessage({ data: managedAudioFrame({ generation: 3 }) });
  session._onMessage({ data: managedAudioFrame({ generation: 3 }) });
  assert.equal(session._audioSegments.get("3:1").dropped, true, "duplicate seq must drop");
});

test("managed audio completes a receipt and a later generation recovers after invalid audio", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const audible = [];
  const session = new RealtimeSession({
    provider: "local",
    onAudibleAssistant: (text, meta) => audible.push({ text, ...meta }),
  });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.audioCtx = { state: "running" };
  session.playbackNode = { port: { postMessage: () => {} } };
  session._onMessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });

  const start = (generation, text, samples) =>
    session._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation,
        segmentId: 1,
        text,
        samples,
      }),
    });

  start(1, "损坏的旧句。", 3);
  session._onMessage({
    data: managedAudioFrame({ generation: 1, chunkSequence: 1 }),
  });
  assert.equal(session._audioSegments.get("1:1").dropped, true);

  start(2, "恢复后完整播完。", 6);
  session._onMessage({
    data: managedAudioFrame({
      generation: 2,
      chunkSequence: 0,
      pcm: new Int16Array([1, 2, 3]),
    }),
  });
  session._onMessage({
    data: managedAudioFrame({
      generation: 2,
      chunkSequence: 1,
      pcm: new Int16Array([4, 5, 6]),
    }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 2, segmentId: 1 }),
  });
  session._onPlaybackMessage({ type: "segment_completed", generation: 2, segmentId: 1 });

  assert.deepEqual(sent, [
    { type: "playback_segment", generation: 2, segmentId: 1, state: "completed" },
  ]);
  assert.deepEqual(audible, [
    { text: "恢复后完整播完。", generation: 2, segmentId: 1 },
  ]);
  assert.equal(JSON.stringify(sent).includes("恢复后"), false);
});

test("managed suspended-queue overflow never delivers partial segment audio", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const commands = [];
  const session = new RealtimeSession({ provider: "local" });
  session.audioCtx = { state: "suspended", resume: () => new Promise(() => {}) };
  session.playbackNode = { port: { postMessage: (message) => commands.push(message) } };
  session._onMessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "挂起队列溢出的句子。",
      samples: 65,
    }),
  });
  for (let chunkSequence = 0; chunkSequence < 65; chunkSequence++) {
    session._onMessage({
      data: managedAudioFrame({
        generation: 1,
        chunkSequence,
        pcm: new Int16Array([chunkSequence]),
      }),
    });
  }
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 1, segmentId: 1 }),
  });

  assert.equal(session._audioSegments.get("1:1").dropped, true);
  session.audioCtx.state = "running";
  session._flushPendingPcm();
  assert.deepEqual(commands.map((message) => message.type), ["startup_buffer", "segment_start", "segment_end"]);
});

test("managed malformed and duplicate segment starts cannot replace the active ledger", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const commands = [];
  const session = new RealtimeSession({ provider: "local" });
  session.playbackNode = { port: { postMessage: (message) => commands.push(message) } };
  session._onMessage({
    data: JSON.stringify({ type: "session", state: "started", downlinkAudio: "managed-v1" }),
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "合法句段。",
      samples: 3,
    }),
  });
  const active = session._currentAudioSegment;
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 2,
      text: "无效样本数。",
      samples: 0,
    }),
  });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "重复句段。",
      samples: 3,
    }),
  });

  assert.equal(session._currentAudioSegment, active);
  assert.equal(session._audioSegments.size, 1);
  assert.deepEqual(commands.map((message) => message.type), ["startup_buffer", "segment_start"]);
  session._onMessage({ data: managedAudioFrame({ generation: 1 }) });
  assert.equal(active.receivedSamples, 3);
});

test("Volcano keeps accepting raw downlink PCM without managed negotiation", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "volcano" });
  session.audioCtx = { state: "suspended", resume: () => new Promise(() => {}) };
  session._onMessage({ data: new Int16Array([1, 2, 3]).buffer });
  assert.equal(session._downlinkAudioMode, "raw");
  assert.equal(session._pendingPcm.length, 1);
  assert.equal(session._pendingPcm[0].segment, null);
});

test("desktop session maps local cascade events without retaining transcript text", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  session.trace.startSession();

  for (const message of [
    { type: "asr_start" },
    { type: "asr", text: "完整用户文本不应进入 trace", interim: false },
    { type: "asr_end" },
    { type: "assistant", text: "完整助手文本也不应进入 trace" },
    { type: "tts_start" },
    { type: "assistant_end" },
  ]) {
    session._onMessage({ data: JSON.stringify(message) });
  }

  const snapshot = session.getTraceSnapshot();
  const eventTypes = snapshot.events.map((event) => event.eventType);
  assert.equal(eventTypes.includes(TRACE_EVENT.SPEECH_CONFIRMED), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_REQUEST), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_RESPONSE), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_FIRST_TOKEN), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.TTS_REQUEST), true);
  assert.equal(JSON.stringify(snapshot).includes("完整用户文本"), false);
  assert.equal(JSON.stringify(snapshot).includes("完整助手文本"), false);
});

test("local session exposes text-free unplayed assistant discard only to the UI", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const discarded = [];
  const session = new RealtimeSession({
    provider: "local",
    onAssistantDiscarded: (meta) => discarded.push(meta),
  });
  session.trace.startSession();
  session._onMessage({
    data: JSON.stringify({ type: "assistant_discarded", generation: 7 }),
  });

  assert.deepEqual(discarded, [{ generation: 7 }]);
  assert.equal(JSON.stringify(session.getTraceSnapshot()).includes("discarded"), false);

  const volcanoDiscarded = [];
  const volcano = new RealtimeSession({
    provider: "volcano",
    onAssistantDiscarded: (meta) => volcanoDiscarded.push(meta),
  });
  volcano._onMessage({
    data: JSON.stringify({ type: "assistant_discarded", generation: 7 }),
  });
  assert.deepEqual(volcanoDiscarded, []);
});

test("desktop session ducks candidates, resumes rejection and gates stale audio", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  const playbackCommands = [];
  session.playbackNode = {
    port: { postMessage: (message) => playbackCommands.push(message) },
  };
  session.trace.startSession();
  session.trace.startResponse();
  session._assistantActive = true;
  session._playbackQueuedMs = 200;

  session._onMessage({ data: JSON.stringify({ type: "speech_candidate" }) });
  assert.equal(playbackCommands.at(-1).type, "duck");
  session._onMessage({ data: JSON.stringify({ type: "speech_rejected" }) });
  assert.equal(playbackCommands.at(-1).type, "resume");

  session._onMessage({ data: JSON.stringify({ type: "speech_candidate" }) });
  session._onMessage({
    data: JSON.stringify({ type: "asr", text: "确认插话", interim: true }),
  });
  assert.equal(session._audioGate, false);
  assert.equal(playbackCommands.at(-1).type, "duck");
  session._onMessage({
    data: JSON.stringify({ type: "asr", text: "确认插话", interim: false }),
  });
  assert.equal(session._audioGate, true);
  assert.equal(playbackCommands.at(-1).type, "clear");
  const commandsBeforeStaleAudio = playbackCommands.length;
  session._onMessage({ data: new ArrayBuffer(480) });
  assert.equal(playbackCommands.length, commandsBeforeStaleAudio);

  const eventTypes = session.getTraceSnapshot().events.map((event) => event.eventType);
  assert.equal(eventTypes.filter((type) => type === TRACE_EVENT.SPEECH_CANDIDATE).length, 2);
  assert.equal(eventTypes.includes(TRACE_EVENT.SPEECH_REJECTED), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.SPEECH_CONFIRMED), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.RESPONSE_CANCELLED), true);
});

test("candidate rejection reopens the audio gate for the segment already admitted by the backend", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const queued = [];
  const session = new RealtimeSession({ provider: "local" });
  session.playbackNode = { port: { postMessage: (message) => queued.push(message) } };
  session.audioCtx = { state: "running" };
  session.trace.startSession();
  session._onMessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      ttsStream: "provider-pcm-v1",
    }),
  });
  session._assistantActive = true;
  session._audioGate = true;
  session._onMessage({ data: JSON.stringify({ type: "speech_candidate" }) });
  session._onMessage({ data: JSON.stringify({ type: "speech_rejected" }) });
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "候选被拒绝后继续播报。",
      streaming: true,
    }),
  });
  session._onMessage({ data: managedAudioFrame({
    generation: 1,
    segmentId: 1,
    chunkSequence: 0,
    payloadSamples: 3,
    pcm: new Int16Array([1, 2, 3]),
  }) });
  assert.equal(session._audioGate, false);
  assert.equal(queued.some((message) => message.type === "audio"), true);
});

test("barge-in attributes cleared playback to the interrupted generation", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  const playbackCommands = [];
  const wireMessages = [];
  session.ws = { readyState: 1, send: (message) => wireMessages.push(JSON.parse(message)) };
  session.playbackNode = {
    port: { postMessage: (message) => playbackCommands.push(message) },
  };
  session.trace.startSession();
  session.trace.openTurn();
  session.trace.startResponse();
  session._assistantActive = true;
  session._playbackQueuedMs = 2202.666;

  session._onMessage({ data: JSON.stringify({ type: "speech_confirmed" }) });
  globalThis.WebSocket = previousWebSocket;

  const events = session.getTraceSnapshot().events;
  const cancelled = events.find((event) => event.eventType === TRACE_EVENT.RESPONSE_CANCELLED);
  const stopped = events.find((event) => event.eventType === TRACE_EVENT.PLAYBACK_STOPPED);
  const confirmed = events
    .filter((event) => event.eventType === TRACE_EVENT.SPEECH_CONFIRMED)
    .at(-1);
  assert.equal(cancelled.reason, "turn_detected");
  assert.equal(stopped.reason, "turn_detected");
  assert.equal(stopped.generationId, cancelled.generationId);
  assert.equal(stopped.metrics.queuedMs, 2202.666);
  assert.ok(confirmed.generationId > stopped.generationId);
  assert.equal(playbackCommands.at(-1).type, "clear");
  assert.deepEqual(wireMessages, [{ type: "playback_reset" }]);
});

test("desktop session rejects stale generation control events before reopening audio", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const assistantMessages = [];
  const session = new RealtimeSession({
    provider: "local",
    onAssistant: (text) => assistantMessages.push(text),
  });
  const playbackCommands = [];
  session.playbackNode = {
    port: { postMessage: (message) => playbackCommands.push(message) },
  };
  session.trace.startSession();
  session._assistantActive = true;

  session._onMessage({
    data: JSON.stringify({ type: "speech_confirmed", generation: 2 }),
  });
  assert.equal(session._audioGate, true);
  session._onMessage({
    data: JSON.stringify({ type: "speaking", generation: 1 }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "assistant", text: "旧回复", generation: 1 }),
  });
  session._onMessage({ data: new ArrayBuffer(480) });

  assert.equal(session._audioGate, true);
  assert.deepEqual(assistantMessages, []);
  assert.equal(playbackCommands.at(-1).type, "clear");

  session._onMessage({
    data: JSON.stringify({ type: "speaking", generation: 2 }),
  });
  assert.equal(session._audioGate, false);
});

test("desktop session returns text-free receipts only for current completed segments", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const audible = [];
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    onAudibleAssistant: (text, meta) => audible.push({ text, ...meta }),
  });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.playbackNode = { port: { postMessage: () => {} } };

  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 3,
      segmentId: 1,
      text: "已经播完的第一句。",
      samples: 2400,
    }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 3, segmentId: 1 }),
  });
  session._onPlaybackMessage({
    type: "segment_completed",
    generation: 3,
    segmentId: 1,
  });
  session._onPlaybackMessage({
    type: "segment_completed",
    generation: 2,
    segmentId: 1,
  });

  assert.deepEqual(audible, [
    { text: "已经播完的第一句。", generation: 3, segmentId: 1 },
  ]);
  assert.deepEqual(sent, [
    { type: "playback_segment", generation: 3, segmentId: 1, state: "completed" },
  ]);
  assert.equal(JSON.stringify(sent).includes("已经播完"), false);
});

test("candidate defers a completed segment until rejection and discards it on confirmation", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const session = new RealtimeSession({ provider: "cosyvoice" });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.playbackNode = { port: { postMessage: () => {} } };
  session.trace.startSession();

  const start = (generation, segmentId) => {
    session._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation,
        segmentId,
        text: `句段${segmentId}。`,
      }),
    });
  };
  start(1, 1);
  session._speechCandidate = true;
  session._onPlaybackMessage({ type: "segment_completed", generation: 1, segmentId: 1 });
  assert.deepEqual(sent, []);
  session._rejectSpeech("voice_rejected");
  assert.equal(sent.filter((message) => message.type !== "playback_reset").length, 1);

  start(2, 1);
  session._speechCandidate = true;
  session._candidateInterruptsResponse = true;
  session._onPlaybackMessage({ type: "segment_completed", generation: 2, segmentId: 1 });
  session._confirmSpeech();
  assert.equal(
    sent.filter((message) => message.type !== "playback_reset").length,
    1,
    "confirmed interruption must not commit the faded tail",
  );
});

test("suspended audio keeps PCM before its segment end marker", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const commands = [];
  const session = new RealtimeSession({ provider: "local" });
  session.audioCtx = {
    state: "suspended",
    resume: () => new Promise(() => {}),
  };
  session.playbackNode = {
    port: { postMessage: (message) => commands.push(message) },
  };
  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "挂起时暂存。",
    }),
  });
  session._onMessage({ data: new Int16Array(240).buffer });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 1, segmentId: 1 }),
  });

  assert.deepEqual(commands.map((message) => message.type), ["segment_start"]);
  assert.deepEqual(session._pendingPcm.map((item) => item.type), ["audio", "segment_end"]);
  session.audioCtx.state = "running";
  session._flushPendingPcm();
  assert.deepEqual(commands.map((message) => message.type), [
    "segment_start",
    "audio",
    "segment_end",
  ]);
});

test("desktop session reports one durable boundary after audible playback drains", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const completed = [];
  const session = new RealtimeSession({
    provider: "local",
    onAudibleResponseComplete: (meta) => completed.push(meta),
  });
  session.ws = { readyState: 1, send: () => {} };
  session.playbackNode = { port: { postMessage: () => {} } };

  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 3,
      segmentId: 1,
      text: "已经完整播完。",
      samples: 2400,
    }),
  });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 3, segmentId: 1 }),
  });
  session._onPlaybackMessage({ type: "segment_completed", generation: 3, segmentId: 1 });
  session._onMessage({ data: JSON.stringify({ type: "tts_end", generation: 3 }) });
  session._onPlaybackMessage({ type: "drained" });

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(completed, [{ generation: 3 }]);

  session._schedulePlaybackCompletion();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(completed, [{ generation: 3 }]);
});

test("legacy playback receipts require natural source completion and remain bounded", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const sent = [];
  const sources = [];
  const session = new RealtimeSession({ provider: "local" });
  session.ws = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
  session.audioCtx = {
    state: "running",
    currentTime: 0,
    destination: {},
    createBuffer: (_channels, length, rate) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const source = {
        connect: () => {},
        start: () => {},
        stop() {
          this.onended?.();
        },
        onended: null,
      };
      sources.push(source);
      return source;
    },
  };

  session._onMessage({
    data: JSON.stringify({
      type: "audio_segment_start",
      generation: 1,
      segmentId: 1,
      text: "自然播完。",
    }),
  });
  session._onMessage({ data: new Int16Array(240).buffer });
  session._onMessage({
    data: JSON.stringify({ type: "audio_segment_end", generation: 1, segmentId: 1 }),
  });
  assert.equal(sent.length, 0);
  sources[0].onended();
  assert.equal(sent.filter((message) => message.type !== "playback_reset").length, 1);
  if (session._playbackDrainTimer) clearTimeout(session._playbackDrainTimer);
  session._playbackDrainTimer = 0;

  for (let generation = 2; generation < 70; generation++) {
    session._onMessage({
      data: JSON.stringify({
        type: "audio_segment_start",
        generation,
        segmentId: 1,
        text: "有界句段。",
      }),
    });
  }
  assert.ok(session._legacySegments.size <= 64);
  session._flushPlayback("turn_detected");
  assert.equal(
    sent.filter((message) => message.type !== "playback_reset").length,
    1,
    "cleared legacy sources must not add receipts",
  );
  if (session._playbackDrainTimer) clearTimeout(session._playbackDrainTimer);
});

test("candidate latches the interrupted response and clears its drain timer", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  const playbackCommands = [];
  session.playbackNode = {
    port: { postMessage: (message) => playbackCommands.push(message) },
  };
  session.trace.startSession();
  session.trace.startResponse();
  session._assistantActive = true;

  session._onMessage({ data: JSON.stringify({ type: "speech_candidate" }) });
  session._assistantActive = false;
  session._playbackQueuedMs = 0;
  session._playbackDrainTimer = setTimeout(() => {
    throw new Error("confirmed interruption must cancel the stale drain timer");
  }, 10);

  session._onMessage({ data: JSON.stringify({ type: "speech_confirmed" }) });

  assert.equal(session._audioGate, true);
  assert.equal(session._playbackDrainTimer, 0);
  assert.equal(playbackCommands.at(-1).type, "clear");
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("local response stays active across stable-sentence TTS gaps", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  session.trace.startSession();
  session.trace.startResponse();

  session._onMessage({ data: JSON.stringify({ type: "tts_start", generation: 1 }) });
  session._onPlaybackMessage({ type: "drained", queuedMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(session.trace.state.response, "active");
  assert.equal(
    session.getTraceSnapshot().events.some(
      (event) => event.eventType === TRACE_EVENT.RESPONSE_COMPLETED,
    ),
    false,
  );

  session._onMessage({ data: JSON.stringify({ type: "tts_end", generation: 1 }) });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(session.trace.state.response, "completed");
});

test("a recoverable local response error clears only that response and keeps the session", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const responseErrors = [];
  const fatalErrors = [];
  const discarded = [];
  const playbackCommands = [];
  const sent = [];
  const session = new RealtimeSession({
    provider: "local",
    onResponseError: (error) => responseErrors.push(error.message),
    onAssistantDiscarded: (meta) => discarded.push(meta),
    onError: (error) => fatalErrors.push(error.message),
  });
  session.ws = {
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  session.playbackNode = {
    port: { postMessage: (message) => playbackCommands.push(message) },
  };
  session.trace.startSession();
  session.trace.startResponse();
  session._backendAudioPending = true;
  session._assistantActive = true;
  session._assistantDraftGeneration = 0;
  session._playbackQueuedMs = 80;

  session._onMessage({
    data: JSON.stringify({
      type: "error",
      message: "本地实时语音处理失败，请稍后重试",
      recoverable: true,
    }),
  });

  assert.deepEqual(responseErrors, ["本地实时语音处理失败，请稍后重试"]);
  assert.deepEqual(fatalErrors, []);
  assert.deepEqual(discarded, [{ generation: 0, preserveAudible: false }]);
  assert.equal(session.stopped, false);
  assert.equal(session._assistantActive, false);
  assert.equal(session._backendAudioPending, false);
  assert.equal(playbackCommands.at(-1).type, "clear");
  assert.equal(sent.at(-1).type, "playback_reset");
});

test("desktop session retains only the latest sanitized VAD shadow summary outside trace", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  session.trace.startSession();
  session._onMessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      vadShadow: "silero-onnx-shadow-v1",
      vadShadowSummary: fixtureVadShadowSummary({
        offered: 3,
        secret: "first-secret",
      }),
    }),
  });
  const traceEvents = session.getTraceSnapshot().events.length;
  const first = session.getTraceSnapshot();
  assert.equal(first.vadShadowSummary.offered, 3);
  first.vadShadowSummary.offered = 999;

  session._onMessage({
    data: JSON.stringify({
      type: "asr_end",
      vadShadowSummary: fixtureVadShadowSummary({
        offered: 7,
        transcript: "latest-secret",
      }),
    }),
  });
  const latest = session.getTraceSnapshot();
  assert.equal(latest.vadShadowSummary.offered, 7);
  assert.equal(latest.events.length, traceEvents);
  assert.equal(JSON.stringify(latest).includes("latest-secret"), false);
});

test("active local and Cosy shadow stops wait only for their final summary", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  for (const [index, provider] of ["local", "cosyvoice"].entries()) {
    const session = new RealtimeSession({ provider });
    session.trace.startSession();
    session._onMessage({
      data: JSON.stringify({
        type: "session",
        state: "started",
        vadShadow: "silero-onnx-shadow-v1",
      }),
    });
    let socketClosed = false;
    session.ws = {
      readyState: 1,
      send(message) {
        if (JSON.parse(message).type !== "hangup") return;
        queueMicrotask(() => {
          session._onMessage({
            data: JSON.stringify({
              type: "vad_shadow_summary",
              final: true,
              summary: fixtureVadShadowSummary({
                offered: 21 + index,
                processedFrames: 13 + index,
              }),
            }),
          });
        });
      },
      close() {
        socketClosed = true;
      },
    };

    await session.stop();
    const snapshot = session.getTraceSnapshot();
    assert.equal(socketClosed, true);
    assert.equal(snapshot.vadShadowSummary.offered, 21 + index);
    assert.equal(snapshot.vadShadowSummary.processedFrames, 13 + index);
    assert.equal(
      snapshot.events.some((event) => event.eventType === "vad_shadow_summary"),
      false,
    );
  }
});

test("old local services time out on one short wait while Volcano never waits", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  globalThis.WebSocket = { OPEN: 1 };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    scheduled.push(delay);
    return originalSetTimeout(callback, 0, ...args);
  };
  try {
    const legacyLocal = new RealtimeSession({ provider: "local" });
    legacyLocal.trace.startSession();
    legacyLocal._onMessage({
      data: JSON.stringify({
        type: "session",
        state: "started",
        vadShadow: "silero-onnx-shadow-v1",
      }),
    });
    legacyLocal.ws = { readyState: 1, send() {}, close() {} };
    await legacyLocal.stop();
    assert.deepEqual(scheduled, [50]);
    assert.equal(legacyLocal.getTraceSnapshot().vadShadowSummary.status, "not-reported");

    const volcano = new RealtimeSession({ provider: "volc" });
    volcano.trace.startSession();
    volcano._vadShadowMode = "silero-onnx-shadow-v1";
    volcano.ws = { readyState: 1, send() {}, close() {} };
    await volcano.stop();
    assert.deepEqual(scheduled, [50]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("stop records a final diagnostic snapshot before audio cleanup settles", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  session.trace.startSession();
  session.trace.startResponse();
  session.audioCtx = {
    currentTime: 0,
    close: () => new Promise(() => {}),
  };

  void session.stop();
  const snapshot = session.getTraceSnapshot();
  assert.equal(session.stopped, true);
  assert.equal(snapshot.state.lifecycle, "ended");
  assert.deepEqual(
    snapshot.events.slice(-2).map((event) => [event.eventType, event.reason]),
    [
      [TRACE_EVENT.RESPONSE_CANCELLED, "hangup"],
      [TRACE_EVENT.SESSION_ENDED, "hangup"],
    ],
  );
});

test("desktop session records privacy-safe soft endpoint transitions", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const { RealtimeSession } = await import("../src/ai/realtime.js");
  const session = new RealtimeSession({ provider: "local" });
  session.trace.startSession();

  for (const message of [
    { type: "endpoint_soft_end", silenceMs: 480 },
    { type: "endpoint_reopened", silenceMs: 900 },
    { type: "endpoint_soft_end", silenceMs: 480 },
    { type: "endpoint_committed", silenceMs: 1050 },
  ]) {
    session._onMessage({ data: JSON.stringify(message) });
  }

  const endpointEvents = session
    .getTraceSnapshot()
    .events.filter((event) => event.eventType.startsWith("endpoint_"));
  assert.deepEqual(
    endpointEvents.map((event) => event.eventType),
    [
      TRACE_EVENT.ENDPOINT_SOFT_END,
      TRACE_EVENT.ENDPOINT_REOPENED,
      TRACE_EVENT.ENDPOINT_SOFT_END,
      TRACE_EVENT.ENDPOINT_COMMITTED,
    ],
  );
  assert.deepEqual(
    endpointEvents.map((event) => event.metrics.silenceMs),
    [480, 900, 480, 1050],
  );
});
