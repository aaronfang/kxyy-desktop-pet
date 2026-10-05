import test from "node:test";
import assert from "node:assert/strict";

import { withSharedExperienceInferencePaused } from "../src/ai/shared-experience-inference.js";
import { createSharedExperienceSpool } from "../src/ai/shared-experience-spool.js";

test("shared-experience speech pauses inference while capture can continue", async () => {
  const spool = createSharedExperienceSpool();
  let pausedDuringTask = false;
  await withSharedExperienceInferencePaused({
    enabled: true,
    spool,
    reason: "tts",
    task: async () => {
      pausedDuringTask = spool.snapshot().inferencePaused;
      spool.push({ kind: "audio", capturedAtMs: 1, payload: "captured-during-speech" });
      assert.deepEqual(spool.drain(), []);
    },
  });

  assert.equal(pausedDuringTask, true);
  assert.deepEqual(spool.drain().map((item) => item.payload), ["captured-during-speech"]);
});

test("speech pause releases on failure without clearing another pause reason", async () => {
  const spool = createSharedExperienceSpool();
  spool.pauseInference("typing");
  await assert.rejects(
    withSharedExperienceInferencePaused({
      enabled: true,
      spool,
      reason: "tts",
      task: async () => { throw new Error("synthesis failed"); },
    }),
    /synthesis failed/,
  );
  assert.deepEqual(spool.snapshot().pauseReasons, ["typing"]);
});

test("disabled inference pause leaves ordinary chat and realtime behavior untouched", async () => {
  const spool = createSharedExperienceSpool();
  const result = await withSharedExperienceInferencePaused({
    enabled: false,
    spool,
    reason: "tts",
    task: async () => spool.snapshot().inferencePaused,
  });
  assert.equal(result, false);
  assert.deepEqual(spool.snapshot().pauseReasons, []);
});
