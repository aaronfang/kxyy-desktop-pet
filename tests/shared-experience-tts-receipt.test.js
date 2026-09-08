import test from "node:test";
import assert from "node:assert/strict";

import { createTtsReceipt } from "../src/ai/shared-experience-tts-receipt.js";

test("TTS receipt distinguishes admission, first audio, completion, and failure", () => {
  let now = 100;
  const receipt = createTtsReceipt({ requestedParts: 2, nowMs: () => now });
  receipt.admit();
  now = 140;
  receipt.start();
  now = 200;
  receipt.complete();
  receipt.fail();
  now = 220;

  assert.deepEqual(receipt.finish(), {
    status: "partial",
    requestedParts: 2,
    admittedParts: 1,
    startedParts: 1,
    completedParts: 1,
    failedParts: 1,
    firstAudioMs: 40,
    totalMs: 120,
  });
});

test("TTS receipt reports failed when no audio starts", () => {
  const receipt = createTtsReceipt({ requestedParts: 1, nowMs: () => 5 });
  receipt.fail();
  assert.equal(receipt.finish().status, "failed");
});

test("TTS receipt aggregates bounded stream starvation metrics", () => {
  const receipt = createTtsReceipt({ requestedParts: 2, nowMs: () => 0 });
  receipt.observeStream({ underrunCount: 2, maxGapMs: 410.4 });
  receipt.observeStream({ underrunCount: 1, maxGapMs: 220 });
  assert.deepEqual(receipt.finish().stream, {
    underrunCount: 3,
    maxGapMs: 410,
  });
});
