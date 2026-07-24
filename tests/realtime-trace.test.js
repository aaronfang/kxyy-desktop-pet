import test from "node:test";
import assert from "node:assert/strict";

import {
  RealtimeTrace,
  TRACE_EVENT,
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
  const localOpen = local._openSocket("ws://local", { systemRole: "role", botName: "元元" });
  sockets[0].onopen();
  await localOpen;
  assert.deepEqual(sockets[0].sent[0].downlinkAudio, ["managed-v1"]);

  const volcano = new RealtimeSession({ provider: "volcano" });
  const volcanoOpen = volcano._openSocket("ws://volcano", {
    systemRole: "role",
    botName: "元元",
  });
  sockets[1].onopen();
  await volcanoOpen;
  assert.equal("downlinkAudio" in sockets[1].sent[0], false);
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
