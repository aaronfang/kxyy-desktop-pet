import test from "node:test";
import assert from "node:assert/strict";
import { appendMemoryBuffer, flushStaleMemoryBuffer } from "../src/ai/memory-buffer.js";

test("append buffer flushes at deterministic Unicode limit", () => {
  const first = appendMemoryBuffer({}, "甲乙", { now: 10, maxChars: 32 });
  assert.equal(first.flushed, "");
  const second = appendMemoryBuffer(first.state, "😀".repeat(30), { now: 20, maxChars: 32 });
  assert.equal(Array.from(second.flushed).length, 32);
  assert.equal(second.state.text, "");
});

test("append buffer stays bounded and stale flush respects minimum threshold", () => {
  const result = appendMemoryBuffer({}, "x".repeat(2000), { now: 1, maxChars: 800 });
  assert.ok(Array.from(result.state.text).length <= 800);
  assert.equal(flushStaleMemoryBuffer({ text: "内容", updatedAt: 100 }, { now: 1000, staleAfterMs: 30_000 }).flushed, "");
  assert.equal(flushStaleMemoryBuffer({ text: "内容", updatedAt: 100 }, { now: 31_000, staleAfterMs: 30_000 }).flushed, "内容");
});
