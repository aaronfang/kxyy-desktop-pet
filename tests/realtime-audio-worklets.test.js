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
    processorOptions: { sourceRate: 24000, maxQueueMs: 1000 },
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
    processorOptions: { sourceRate: 24000, maxQueueMs: 250 },
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
    processorOptions: { sourceRate: 24000, maxQueueMs: 250 },
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
