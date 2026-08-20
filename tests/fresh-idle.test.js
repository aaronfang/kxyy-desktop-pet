import test from "node:test";
import assert from "node:assert/strict";
import {
  createFreshIdleState,
  markFreshIdleTriggered,
  recordFreshIdleActivity,
  shouldTriggerFreshIdle,
} from "../src/ai/fresh-idle.js";

test("idle trigger requires a quiet eligible conversation and fires once", () => {
  const state = createFreshIdleState({ nowMs: 0, delayMs: 90_000 });
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 89_999, enabled: true, participation: "active" }), false);
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 90_000, enabled: true, participation: "active" }), true);
  assert.equal(markFreshIdleTriggered(state), true);
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 180_000, enabled: true, participation: "active" }), false);
});

test("idle trigger vetoes input, media, calls, serious context, and relevant-only mode", () => {
  const flags = ["busy", "hasPendingMedia", "callActive", "inputFocused", "seriousContext", "hidden"];
  for (const flag of flags) {
    const state = createFreshIdleState({ nowMs: 0 });
    assert.equal(shouldTriggerFreshIdle(state, { nowMs: 100_000, enabled: true, participation: "active", [flag]: true }), false, flag);
  }
  const state = createFreshIdleState({ nowMs: 0 });
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 100_000, enabled: true, participation: "relevant" }), false);
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 100_000, enabled: true, participation: "active", ambientUsed: true }), false);
});

test("new activity postpones idle trigger", () => {
  const state = createFreshIdleState({ nowMs: 0, delayMs: 90_000 });
  recordFreshIdleActivity(state, 80_000);
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 150_000, enabled: true, participation: "occasional" }), false);
  assert.equal(shouldTriggerFreshIdle(state, { nowMs: 170_000, enabled: true, participation: "occasional" }), true);
});
