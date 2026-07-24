import test from "node:test";
import assert from "node:assert/strict";

import {
  RealtimeTrace,
  TRACE_EVENT,
  buildRealtimeDiagnosticReport,
  createTraceEvent,
  replayTrace,
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
      url: "forbidden-url",
    },
    events,
    latencies: [summarizeTraceLatency(events, 0)],
    persona: "forbidden-persona",
  });

  assert.deepEqual(report.runtime, {
    provider: "cosyvoice",
    playbackMode: "worklet",
    downlinkAudio: "managed-v1",
    ttsStream: "provider-pcm-v1",
    interruptionHint: "candidate-snapshot-v1",
  });
  assert.deepEqual(report.exportStats, {
    sourceDroppedEvents: 17,
    truncatedEvents: 5,
    rejectedItems: 1,
    coalescedPlaybackStats: 23,
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
  ]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("diagnostic export fails closed on unknown runtime capability values", () => {
  const report = buildRealtimeDiagnosticReport({
    runtime: {
      provider: "custom-provider",
      playbackMode: "future-mode",
      downlinkAudio: "future-envelope",
      ttsStream: "future-stream",
      interruptionHint: "future-hint",
    },
  });
  assert.deepEqual(report.runtime, {
    provider: "unknown",
    playbackMode: "none",
    downlinkAudio: "raw",
    ttsStream: "none",
    interruptionHint: "none",
  });
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

test("managed audio is explicitly offered only by cascade clients", async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
  const sockets = [];
  globalThis.WebSocket = class {
    constructor() {
      this.sent = [];
      sockets.push(this);
    }

    send(message) {
      this.sent.push(JSON.parse(message));
    }
  };
  const { RealtimeSession } = await import("../src/ai/realtime.js");

  const local = new RealtimeSession({ provider: "local" });
  local._playbackMode = "worklet";
  local.playbackNode = { port: { postMessage: () => {} } };
  const localOpen = local._openSocket("ws://local", { systemRole: "role", botName: "元元" });
  sockets[0].onopen();
  await localOpen;
  assert.deepEqual(sockets[0].sent[0].downlinkAudio, ["managed-v1"]);
  assert.deepEqual(sockets[0].sent[0].interruptionHint, ["candidate-snapshot-v1"]);
  assert.deepEqual(sockets[0].sent[0].ttsStream, ["provider-pcm-v1"]);
  local.trace.startSession();
  local._onMessage({
    data: JSON.stringify({
      type: "session",
      state: "started",
      downlinkAudio: "managed-v1",
      interruptionHint: "candidate-snapshot-v1",
      ttsStream: "provider-pcm-v1",
    }),
  });
  assert.deepEqual(local.getTraceSnapshot().runtime, {
    provider: "local",
    playbackMode: "worklet",
    downlinkAudio: "managed-v1",
    ttsStream: "provider-pcm-v1",
    interruptionHint: "candidate-snapshot-v1",
  });

  const cosy = new RealtimeSession({ provider: "cosyvoice" });
  cosy._playbackMode = "worklet";
  cosy.playbackNode = { port: { postMessage: () => {} } };
  const cosyOpen = cosy._openSocket("ws://cosy", { systemRole: "role", botName: "元元" });
  sockets[1].onopen();
  await cosyOpen;
  assert.deepEqual(sockets[1].sent[0].downlinkAudio, ["managed-v1"]);
  assert.deepEqual(sockets[1].sent[0].interruptionHint, ["candidate-snapshot-v1"]);
  assert.deepEqual(sockets[1].sent[0].ttsStream, ["provider-pcm-v1"]);

  const legacy = new RealtimeSession({ provider: "local" });
  legacy._playbackMode = "legacy";
  const legacyOpen = legacy._openSocket("ws://legacy", {
    systemRole: "role",
    botName: "元元",
  });
  sockets[2].onopen();
  await legacyOpen;
  assert.deepEqual(sockets[2].sent[0].downlinkAudio, ["managed-v1"]);
  assert.equal("interruptionHint" in sockets[2].sent[0], false);
  assert.equal("ttsStream" in sockets[2].sent[0], false);

  const volcano = new RealtimeSession({ provider: "volcano" });
  const volcanoOpen = volcano._openSocket("ws://volcano", {
    systemRole: "role",
    botName: "元元",
  });
  sockets[3].onopen();
  await volcanoOpen;
  assert.equal("downlinkAudio" in sockets[3].sent[0], false);
  assert.equal("interruptionHint" in sockets[3].sent[0], false);
  assert.equal("ttsStream" in sockets[3].sent[0], false);
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

  const unnegotiated = createSession(null).session;
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
  assert.deepEqual(sent, [
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
  assert.equal(sent.length, 1, "one candidate may send at most one receipt");

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
  assert.equal(sent.length, 2, "a snapshot arriving after clear keeps numeric identity only");

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
    sent.length,
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
  assert.deepEqual(commands.map((message) => message.type), ["segment_start"]);
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
  assert.deepEqual(commands.map((message) => message.type), ["segment_start", "segment_end"]);
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
  assert.deepEqual(commands.map((message) => message.type), ["segment_start"]);
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
  assert.equal(sent.length, 1);

  start(2, 1);
  session._speechCandidate = true;
  session._candidateInterruptsResponse = true;
  session._onPlaybackMessage({ type: "segment_completed", generation: 2, segmentId: 1 });
  session._confirmSpeech();
  assert.equal(sent.length, 1, "confirmed interruption must not commit the faded tail");
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
  assert.equal(sent.length, 1);
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
  assert.equal(sent.length, 1, "cleared legacy sources must not add receipts");
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
