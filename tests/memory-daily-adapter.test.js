import test from "node:test";
import assert from "node:assert/strict";
import { selectDailyMemoryDigest } from "../src/ai/memory-daily-adapter.js";

test("daily digest adapter is disabled by default and bounded when enabled", () => {
  const items = [{ sourceId: "s", observedAt: 1720000000 }];
  assert.deepEqual(selectDailyMemoryDigest({ items }), { mode: "disabled", days: [] });
  const selected = selectDailyMemoryDigest({ enabled: true, items, timezone: "Asia/Shanghai" });
  assert.equal(selected.mode, "aggregate");
  assert.equal(selected.days[0].timezone, "Asia/Shanghai");
});

test("daily digest adapter fails closed on empty input", () => {
  assert.deepEqual(selectDailyMemoryDigest({ enabled: true, items: [] }), { mode: "empty", days: [] });
});
