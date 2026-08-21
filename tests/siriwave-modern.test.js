import test from "node:test";
import assert from "node:assert/strict";

import { createSiriWaveModernRenderer } from "../src/siriwave-modern.js";

function createRecordingCanvas() {
  const frames = [];
  const colors = [];
  let points = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    setTransform() {},
    clearRect() {},
    createLinearGradient() { return gradient; },
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    closePath() {},
    fill() { frames.push(points); colors.push(this.fillStyle); },
    fillRect() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 188, height: 34 }),
  };
  return { canvas, frames, colors };
}

function profileOf(frame) {
  return frame.slice(1, Math.floor(frame.length / 2)).map(([, y]) => y);
}

function meanDelta(before, after) {
  let total = 0;
  for (let i = 0; i < before.length; i++) total += Math.abs(before[i] - after[i]);
  return total / before.length;
}

function peakAmplitude(profile, center = 17) {
  return Math.max(...profile.map((y) => Math.abs(y - center)));
}

test("modern waveform ignores per-bin churn when the audible level is steady", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const even = Float32Array.from({ length: 48 }, (_, i) => i % 2 ? 0 : .8);
  const odd = Float32Array.from({ length: 48 }, (_, i) => i % 2 ? .8 : 0);
  const run = (waveform) => {
    const harness = createRecordingCanvas();
    const renderer = createSiriWaveModernRenderer(harness.canvas);
    for (let i = 0; i < 30; i++) renderer.draw(.35, waveform, i * 16.67);
    return profileOf(harness.frames.at(-4));
  };

  assert.equal(meanDelta(run(even), run(odd)), 0, "steady volume should not produce jittery local peaks");
});

test("modern waveform interpolation is stable across refresh rates", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const run = (stepMs, framesCount) => {
    const harness = createRecordingCanvas();
    const renderer = createSiriWaveModernRenderer(harness.canvas);
    for (let i = 0; i <= framesCount; i++) renderer.draw(.4, null, i * stepMs);
    return profileOf(harness.frames.at(-4));
  };

  const at60Hz = run(1000 / 60, 60);
  const at30Hz = run(1000 / 30, 30);
  assert.ok(meanDelta(at60Hz, at30Hz) < .2, "one second of animation should not depend on refresh rate");
});

test("modern waveform filters 30Hz RMS steps without visibly pumping", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const steadyHarness = createRecordingCanvas();
  const steppedHarness = createRecordingCanvas();
  const steady = createSiriWaveModernRenderer(steadyHarness.canvas);
  const stepped = createSiriWaveModernRenderer(steppedHarness.canvas);
  let accumulatedDelta = 0;
  let measuredFrames = 0;

  for (let frame = 0; frame < 90; frame++) {
    const now = frame * 16.67;
    steady.draw(.26, null, now);
    stepped.draw(Math.floor(frame / 2) % 2 ? .34 : .18, null, now);
    if (frame < 30) continue;
    accumulatedDelta += meanDelta(
      profileOf(steadyHarness.frames.at(-4)),
      profileOf(steppedHarness.frames.at(-4)),
    );
    measuredFrames++;
  }

  assert.ok(accumulatedDelta / measuredFrames < .025, "small RMS steps should not visibly pump the wave");
});

test("modern waveform visibly responds within 33ms of a speech onset", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const harness = createRecordingCanvas();
  const renderer = createSiriWaveModernRenderer(harness.canvas);
  renderer.draw(0, null, 0);
  renderer.draw(.5, null, 16.67);
  renderer.draw(.5, null, 33.34);

  assert.ok(
    peakAmplitude(profileOf(harness.frames.at(-4))) >= 12,
    "speech onset should expand the wave without waiting for cascaded filters",
  );
});

test("modern waveform has no colored motion while silent", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const harness = createRecordingCanvas();
  const renderer = createSiriWaveModernRenderer(harness.canvas);
  for (let frame = 0; frame < 60; frame++) renderer.draw(0, null, frame * 16.67);

  for (const frame of harness.frames.slice(-4)) {
    assert.equal(peakAmplitude(profileOf(frame)), 0);
  }
});

test("call state changes palette without changing waveform geometry", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const idleHarness = createRecordingCanvas();
  const speakingHarness = createRecordingCanvas();
  const idle = createSiriWaveModernRenderer(idleHarness.canvas);
  const speaking = createSiriWaveModernRenderer(speakingHarness.canvas, { state: "speaking" });
  for (let frame = 0; frame < 30; frame++) {
    idle.draw(.35, null, frame * 16.67);
    speaking.draw(.35, null, frame * 16.67);
  }

  assert.deepEqual(profileOf(idleHarness.frames.at(-4)), profileOf(speakingHarness.frames.at(-4)));
  assert.notEqual(idleHarness.colors.at(-4), speakingHarness.colors.at(-4));
});

test("call state palette transition is stable across refresh rates", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const run = (stepMs, frameCount) => {
    const harness = createRecordingCanvas();
    const renderer = createSiriWaveModernRenderer(harness.canvas);
    renderer.draw(.35, null, 0);
    renderer.setState("speaking", 0);
    for (let frame = 1; frame <= frameCount; frame++) renderer.draw(.35, null, frame * stepMs);
    return harness.colors.slice(-4);
  };

  assert.deepEqual(run(1000 / 60, 6), run(1000 / 30, 3));
});

test("unknown call state falls back to idle", () => {
  globalThis.window = { devicePixelRatio: 1 };
  const harness = createRecordingCanvas();
  const renderer = createSiriWaveModernRenderer(harness.canvas, { state: "surprise" });
  assert.equal(renderer.getState(), "idle");
  assert.equal(renderer.setState("unknown", 0), "idle");
});
