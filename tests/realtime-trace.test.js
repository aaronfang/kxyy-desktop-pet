import test from "node:test";
import assert from "node:assert/strict";

import {
  RealtimeTrace,
  TRACE_EVENT,
  createTraceEvent,
  replayTrace,
  summarizeTraceLatency,
} from "../src/ai/realtime-trace.js";

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
    asrToLlmFirstOutputMs: 70,
    llmRequestToTtsFirstAudioMs: null,
    ttsFirstAudioToPlaybackMs: 10,
    speechToPlaybackMs: 230,
  });
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
    { type: "assistant_end" },
  ]) {
    session._onMessage({ data: JSON.stringify(message) });
  }

  const snapshot = session.getTraceSnapshot();
  const eventTypes = snapshot.events.map((event) => event.eventType);
  assert.equal(eventTypes.includes(TRACE_EVENT.SPEECH_CONFIRMED), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_REQUEST), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_RESPONSE), true);
  assert.equal(eventTypes.includes(TRACE_EVENT.LLM_FIRST_TOKEN), false);
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
