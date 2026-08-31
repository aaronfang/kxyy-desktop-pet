import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyMemoryDigest } from "../src/ai/memory-daily-digest.js";

test("daily digest groups bounded source metadata without text", () => {
  const digest = buildDailyMemoryDigest([{ sourceId: "s1", observedAt: 1720000000 }, { sourceId: "s2", observedAt: 1720000000, conflictKey: "k", uncertain: true }], { timezone: "Asia/Shanghai" });
  assert.equal(digest.length, 1);
  assert.deepEqual(digest[0].sourceIds, ["s1", "s2"]);
  assert.equal(digest[0].conflictCount, 1);
  assert.equal(digest[0].uncertainCount, 1);
  assert.equal(digest[0].text, undefined);
});

test("daily digest ignores invalid observations and caps days", () => {
  const digest = buildDailyMemoryDigest([{ sourceId: "x", observedAt: 0 }, { sourceId: "y", observedAt: 1720000000 }], { maxDays: 1 });
  assert.equal(digest.length, 1);
});
