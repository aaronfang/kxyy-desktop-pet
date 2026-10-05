import test from "node:test";
import assert from "node:assert/strict";

import { createSharedExperienceVoiceTracker } from "../src/ai/shared-experience-voice-tracker.js";

test("voice tracker counts a running-failed-running transition as an unexpected restart", () => {
  let now = 100;
  const tracker = createSharedExperienceVoiceTracker({ backend: "voxcpm", nowMs: () => now });
  tracker.record({ backend: "voxcpm", state: "starting", message: "private path" });
  now = 120;
  tracker.record({ backend: "voxcpm", state: "running" });
  now = 140;
  tracker.record({ backend: "voxcpm", state: "failed", message: "raw error" });
  now = 180;
  tracker.record({ backend: "voxcpm", state: "running" });

  assert.deepEqual(tracker.snapshot(), {
    backend: "voxcpm",
    runningSeen: true,
    failures: 1,
    unexpectedRestarts: 1,
    events: [
      { atMs: 0, state: "starting" },
      { atMs: 20, state: "running" },
      { atMs: 40, state: "failed" },
      { atMs: 80, state: "running" },
    ],
  });
});

test("voice tracker ignores other backends and unknown states", () => {
  const tracker = createSharedExperienceVoiceTracker({ backend: "voxcpm", nowMs: () => 0 });
  tracker.record({ backend: "cosyvoice", state: "failed" });
  tracker.record({ backend: "voxcpm", state: "secret-state" });
  assert.deepEqual(tracker.snapshot().events, []);
});
