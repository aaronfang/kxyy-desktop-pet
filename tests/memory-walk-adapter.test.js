import test from "node:test";
import assert from "node:assert/strict";
import { recallByEntityWalk } from "../src/ai/memory-walk-adapter.js";

test("entity walk adapter is disabled by default and bounded when enabled", async () => {
  let calls = 0;
  assert.deepEqual(await recallByEntityWalk({ invoke: async () => { calls += 1; return []; }, scope: "s", entity: "元元" }), []);
  assert.equal(calls, 0);
  const rows = await recallByEntityWalk({ enabled: true, invoke: async (_name, request) => { assert.equal(request.maxItems, 16); return Array.from({ length: 30 }, (_, i) => ({ chunkId: `c${i}`, text: "x".repeat(500), sourceId: "s", sourceType: "text_chat", observedAt: i })); }, scope: "s", entity: "元元", maxItems: 99 });
  assert.equal(rows.length, 16);
  assert.equal(rows[0].text.length, 320);
});

test("entity walk failures fail closed to existing recall", async () => {
  assert.deepEqual(await recallByEntityWalk({ enabled: true, invoke: async () => { throw new Error("db"); }, scope: "s", entity: "x" }), []);
});
