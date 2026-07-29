import test from "node:test";
import assert from "node:assert/strict";

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  dispatch(data) {
    this.onmessage?.({ data });
  }
}

class FakeAudioWorkletProcessor {
  constructor() {
    this.port = new FakePort();
  }
}

async function loadProcessor(file, name, rate) {
  const processors = new Map();
  globalThis.sampleRate = rate;
  globalThis.AudioWorkletProcessor = FakeAudioWorkletProcessor;
  globalThis.registerProcessor = (processorName, Processor) => {
    processors.set(processorName, Processor);
  };
  await import(`../src/ai/${file}?test=${name}-${rate}-${Math.random()}`);
  return processors.get(name);
}

function outputBlock(length = 128) {
  return [[new Float32Array(length)]];
}

test("playback worklet ducks, pauses consumption, resumes and clears", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(12000).fill(12000);
  player.port.dispatch({ type: "audio", pcm: pcm.buffer });
  assert.equal(player.size, 12000);

  player.port.dispatch({ type: "duck" });
  for (let i = 0; i < 12; i++) player.process([], outputBlock());
  assert.equal(player.state, "paused");
  const pausedSize = player.size;
  player.process([], outputBlock(512));
  assert.equal(player.size, pausedSize, "paused playback must preserve the continuation");

  player.port.dispatch({ type: "resume" });
  player.process([], outputBlock(512));
  assert.ok(player.size < pausedSize, "resumed playback must consume queued PCM");

  player.port.dispatch({ type: "clear" });
  assert.equal(player.size, 0);
  assert.equal(player.state, "playing");
  assert.equal(player.port.messages.at(-1).type, "cleared");
});

test("playback worklet bounds paused PCM and reports overflow", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 250, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(7000).fill(4000);
  player.port.dispatch({ type: "audio", pcm: pcm.buffer });

  assert.equal(player.capacity, 6000);
  assert.equal(player.size, 6000);
  assert.equal(player.droppedSamples, 1000);
  assert.equal(player.port.messages.at(-1).queuedMs, 250);
});

test("playback worklet resamples 24k PCM into a 48k output", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 250, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(240).fill(16384);
  player.port.dispatch({ type: "audio", pcm: pcm.buffer });
  const outputs = outputBlock(480);
  player.process([], outputs);

  const rendered = outputs[0][0];
  assert.ok(rendered.slice(0, 470).every((sample) => Math.abs(sample - 0.5) < 0.001));
  assert.equal(player.playedSamples, 240);
  assert.equal(player.size, 0);
});

test("playback worklet acknowledges only fully consumed sentence segments", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 250, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(240).fill(8000);
  player.port.dispatch({ type: "segment_start", generation: 7, segmentId: 1 });
  player.port.dispatch({
    type: "audio",
    pcm: pcm.buffer,
    generation: 7,
    segmentId: 1,
  });
  player.port.dispatch({ type: "segment_end", generation: 7, segmentId: 1 });
  player.process([], outputBlock(480));

  const completed = player.port.messages.filter(
    (message) => message.type === "segment_completed",
  );
  assert.deepEqual(completed.map(({ generation, segmentId }) => [generation, segmentId]), [
    [7, 1],
  ]);

  player.port.dispatch({ type: "segment_start", generation: 7, segmentId: 2 });
  player.port.dispatch({
    type: "audio",
    pcm: pcm.buffer,
    generation: 7,
    segmentId: 2,
  });
  player.port.dispatch({ type: "segment_end", generation: 7, segmentId: 2 });
  player.port.dispatch({ type: "clear" });
  player.process([], outputBlock(480));
  assert.equal(
    player.port.messages.filter((message) => message.type === "segment_completed").length,
    1,
    "cleared audio must not become audible history",
  );
});

test("playback worklet snapshots exact active-segment source progress", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 3000, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(48000).fill(8000);
  player.port.dispatch({ type: "segment_start", generation: 9, segmentId: 2 });
  player.port.dispatch({
    type: "audio",
    pcm: pcm.buffer,
    generation: 9,
    segmentId: 2,
  });
  player.port.dispatch({ type: "segment_end", generation: 9, segmentId: 2 });

  player.process([], outputBlock(48000));
  player.port.dispatch({ type: "candidate_snapshot", candidateId: 17 });
  const firstSnapshot = player.port.messages.at(-1);
  assert.deepEqual(
    {
      type: firstSnapshot.type,
      candidateId: firstSnapshot.candidateId,
      generation: firstSnapshot.generation,
      segmentId: firstSnapshot.segmentId,
      playedSamples: firstSnapshot.playedSamples,
      inProgress: firstSnapshot.inProgress,
    },
    {
    type: "candidate_snapshot",
    candidateId: 17,
    generation: 9,
    segmentId: 2,
    playedSamples: 24000,
    inProgress: true,
    },
  );

  player.process([], outputBlock(48000));
  player.port.dispatch({ type: "candidate_snapshot", candidateId: 18 });
  assert.equal(player.port.messages.at(-1).candidateId, 18);
  assert.equal(player.port.messages.at(-1).playedSamples, 0);
  assert.equal(player.port.messages.at(-1).inProgress, false);

  player.port.dispatch({ type: "clear" });
  player.port.dispatch({ type: "candidate_snapshot", candidateId: 19 });
  assert.equal(player.port.messages.at(-1).inProgress, false);
  const messageCount = player.port.messages.length;
  player.port.dispatch({ type: "candidate_snapshot", candidateId: 0 });
  assert.equal(player.port.messages.length, messageCount);
});

test("playback worklet suppresses segment receipts after ring overflow", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 250, startupBufferMs: 0 },
  });
  const pcm = new Int16Array(7000).fill(8000);
  player.port.dispatch({ type: "segment_start", generation: 8, segmentId: 1 });
  player.port.dispatch({
    type: "audio",
    pcm: pcm.buffer,
    generation: 8,
    segmentId: 1,
  });
  player.port.dispatch({ type: "segment_end", generation: 8, segmentId: 1 });
  for (let i = 0; i < 50 && player.size > 0; i++) player.process([], outputBlock(512));
  assert.equal(
    player.port.messages.some((message) => message.type === "segment_completed"),
    false,
  );
});

test("playback worklet coalesces untagged spans without dropping valid ring audio", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 3000, startupBufferMs: 0 },
  });
  for (let i = 0; i < 129; i++) {
    player.port.dispatch({ type: "audio", pcm: new Int16Array([i]).buffer });
  }
  assert.equal(player.size, 129);
  assert.equal(player.droppedSamples, 0);
  assert.equal(player.spans.length, 1);
});

test("playback worklet waits for a 240ms startup reservoir", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000 },
  });
  const chunk = new Int16Array(1920).fill(12000);

  player.port.dispatch({ type: "audio", pcm: chunk.buffer });
  player.process([], outputBlock(480));
  assert.equal(player.size, 1920, "the first 80ms chunk must remain buffered");
  assert.equal(player.port.messages.some((message) => message.type === "started"), false);

  player.port.dispatch({ type: "audio", pcm: chunk.slice().buffer });
  player.port.dispatch({ type: "audio", pcm: chunk.slice().buffer });
  player.process([], outputBlock(480));
  assert.ok(player.size < 5760, "playback starts after the 240ms target is reached");
  assert.equal(player.port.messages.some((message) => message.type === "started"), true);
});

test("playback worklet releases a complete short segment below startup target", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000 },
  });
  const pcm = new Int16Array(960).fill(8000);
  player.port.dispatch({ type: "segment_start", generation: 2, segmentId: 1 });
  player.port.dispatch({
    type: "audio",
    pcm: pcm.buffer,
    generation: 2,
    segmentId: 1,
  });
  player.process([], outputBlock(480));
  assert.equal(player.size, 960);
  player.port.dispatch({ type: "segment_end", generation: 2, segmentId: 1 });
  player.process([], outputBlock(1920));
  assert.equal(player.size, 0);
  assert.equal(
    player.port.messages.some((message) => message.type === "segment_completed"),
    true,
  );
});

test("playback worklet rearms startup buffering after a drain", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000 },
  });
  const reservoir = new Int16Array(5760).fill(9000);
  player.port.dispatch({ type: "audio", pcm: reservoir.buffer });
  player.process([], outputBlock(12000));
  assert.equal(player.size, 0);
  assert.equal(player.buffering, true);

  const next = new Int16Array(1920).fill(9000);
  player.port.dispatch({ type: "audio", pcm: next.buffer });
  player.process([], outputBlock(480));
  assert.equal(player.size, 1920, "a later 80ms chunk must rebuffer after drain");
});

test("raw playback does not strand a short tail after a drain", async () => {
  const Playback = await loadProcessor("playback-worklet.js", "pcm-playback", 48000);
  const player = new Playback({
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000, startupBufferMs: 0 },
  });
  const first = new Int16Array(1920).fill(9000);
  player.port.dispatch({ type: "audio", pcm: first.buffer });
  player.process([], outputBlock(4800));
  assert.equal(player.size, 0);
  assert.equal(player.buffering, false);

  const tail = new Int16Array(960).fill(9000);
  player.port.dispatch({ type: "audio", pcm: tail.buffer });
  player.process([], outputBlock(2400));
  assert.equal(player.size, 0, "raw tail below 240ms must remain immediately playable");
});

test("capture worklet keeps fractional 44.1k to 16k resampling state across blocks", async () => {
  const Capture = await loadProcessor("pcm-worklet.js", "pcm-capture", 44100);
  const capture = new Capture({ processorOptions: { targetRate: 16000 } });

  let phase = 0;
  for (let block = 0; block < 9; block++) {
    const input = new Float32Array(128);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin(phase);
      phase += (2 * Math.PI * 440) / 44100;
    }
    capture.process([[input]]);
  }

  assert.ok(capture.port.messages.length >= 1);
  const frame = new Int16Array(capture.port.messages[0]);
  assert.equal(frame.length, 320);
  assert.ok(frame.some((sample) => sample !== 0));
  assert.ok(Math.abs(capture._nextOutputAt - capture.ratio * 418) < capture.ratio);
});
