import test from "node:test";
import assert from "node:assert/strict";
import { selectMemorySummary } from "../src/ai/memory-summary-adapter.js";

test("summary adapter is fail-closed and disabled by default", () => {
  const items = [{ sourceId: "s", observedAt: 1, text: "内容" }];
  assert.deepEqual(selectMemorySummary({ items }), { mode: "recall", text: "", sourceIds: [] });
  const selected = selectMemorySummary({ enabled: true, items });
  assert.equal(selected.mode, "summary");
  assert.deepEqual(selected.sourceIds, ["s"]);
  assert.match(selected.text, /\[s\|1\]/);
});

test("summary adapter falls back when no provenance is available", () => {
  assert.deepEqual(selectMemorySummary({ enabled: true, items: [{ text: "不应摘要" }] }), { mode: "recall", text: "", sourceIds: [] });
});
