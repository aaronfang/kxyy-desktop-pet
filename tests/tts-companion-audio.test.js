import test from "node:test";
import assert from "node:assert/strict";

import { resetPlaybackPipeline, setCompanionAudioActive, streamSpeech } from "../src/ai/tts.js";

class FakeAudioContext {
  static instances = [];

  constructor() {
    this.state = "suspended";
    this.resumeCalls = 0;
    this.oscillators = [];
    this.destination = {};
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return { gain: { value: 0 }, connect() {}, disconnect() {} };
  }

  createOscillator() {
    const oscillator = { started: false, stopped: false, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  async resume() {
    this.resumeCalls += 1;
    this.state = "running";
  }

  async close() {
    this.state = "closed";
  }
}

test("companion audio keeps its unlocked output chain while co-viewing and releases it on stop", async () => {
  globalThis.window = { AudioContext: FakeAudioContext };
  try {
    setCompanionAudioActive(true);
    const context = FakeAudioContext.instances.at(-1);
    await Promise.resolve();
    assert.equal(context.resumeCalls > 0, true);
    assert.equal(context.oscillators.length, 1);
    assert.equal(context.oscillators[0].started, true);
    setCompanionAudioActive(false);
    assert.equal(context.oscillators[0].stopped, true);
  } finally {
    setCompanionAudioActive(false);
    resetPlaybackPipeline();
    delete globalThis.window;
  }
});

test("suspended output reports a fixed pre-admission failure without requesting TTS", async () => {
  class StuckAudioContext extends FakeAudioContext {
    async resume() { this.resumeCalls += 1; }
  }
  globalThis.window = { AudioContext: StuckAudioContext };
  const failures = [];
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("unexpected request"); };
  try {
    const result = await streamSpeech("测试语音", { onError: (error) => failures.push(error.code) });
    assert.equal(result, false);
    assert.deepEqual(failures, ["audio-context-suspended"]);
    assert.equal(requests, 0);
  } finally {
    resetPlaybackPipeline();
    delete globalThis.fetch;
    delete globalThis.window;
  }
});
