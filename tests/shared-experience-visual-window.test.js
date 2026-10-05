import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSharedExperienceVisualCapture } from "../src/ai/shared-experience-visual-window.js";

const jpeg = (name) => `data:image/jpeg;base64,${name}`;

test("pending visual sampling updates bounded diagnostics without creating evidence", () => {
  const result = normalizeSharedExperienceVisualCapture({
    status: "pending",
    diagnostics: {
      state: "quiet", bufferedFrames: 7, sampledFrames: 18, emittedWindows: 2,
      coalescedFrames: 10, droppedFrames: 1, latestChangeScorePpm: 12345,
      nextWindowInMs: 3210, unexpectedText: "private window title",
    },
  });
  assert.deepEqual(result, {
    pending: true,
    window: null,
    diagnostics: {
      state: "quiet", bufferedFrames: 7, sampledFrames: 18, emittedWindows: 2,
      coalescedFrames: 10, droppedFrames: 1, latestChangeScorePpm: 12345,
      nextWindowInMs: 3210,
    },
  });
});

test("a mature visual window keeps chronological frames and fixed trigger enums", () => {
  const result = normalizeSharedExperienceVisualCapture({
    status: "ok",
    window: {
      state: "intense", reason: "scene-cut", sampledFrames: 8,
      frames: [
        { capturedAtMs: 1000, imageDataUrl: jpeg("one") },
        { capturedAtMs: 1500, imageDataUrl: jpeg("two") },
        { capturedAtMs: 3000, imageDataUrl: jpeg("three") },
      ],
    },
    diagnostics: { state: "intense", sampledFrames: 8, emittedWindows: 1 },
  });
  assert.equal(result.pending, false);
  assert.equal(result.window.capturedAtMs, 3000);
  assert.equal(result.window.frames.length, 3);
  assert.equal(result.window.reason, "scene-cut");
  assert.equal(result.diagnostics.state, "intense");
});

test("invalid, oversized, or unordered visual windows fail closed", () => {
  const base = {
    status: "ok",
    window: { state: "normal", reason: "interval", sampledFrames: 2, frames: [] },
  };
  assert.equal(normalizeSharedExperienceVisualCapture(base), null);
  assert.equal(normalizeSharedExperienceVisualCapture({ ...base, window: {
    ...base.window,
    frames: [
      { capturedAtMs: 1000, imageDataUrl: jpeg("one") },
      { capturedAtMs: 900, imageDataUrl: jpeg("two") },
    ],
  } }), null);
  assert.equal(normalizeSharedExperienceVisualCapture({ ...base, window: {
    ...base.window,
    frames: Array.from({ length: 5 }, (_, index) => ({ capturedAtMs: 1000 + index, imageDataUrl: jpeg(index) })),
  } }), null);
  assert.equal(normalizeSharedExperienceVisualCapture({ ...base, window: {
    ...base.window,
    state: "secret-mode",
    frames: [
      { capturedAtMs: 1000, imageDataUrl: jpeg("one") },
      { capturedAtMs: 1500, imageDataUrl: jpeg("two") },
    ],
  } }), null);
});
