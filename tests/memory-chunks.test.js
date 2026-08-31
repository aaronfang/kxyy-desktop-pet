import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryChunks, splitMemoryText } from "../src/ai/memory-chunks.js";

const source = { sourceId: "chat-1", sourceType: "text_chat", scope: "card/user", observedAt: 10, eventIds: ["e1"] };

test("splits on Unicode code points with fixed bounded offsets", () => {
  const text = "甲乙😀丙丁".repeat(7);
  const chunks = splitMemoryText(text, { maxChars: 32 });
  assert.equal(chunks[0].end, 32);
  assert.equal(chunks[1].start, 32);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
});

test("content-addressed chunks are deterministic and preserve provenance", () => {
  const first = createMemoryChunks("一".repeat(700), source, { maxChars: 320 });
  const second = createMemoryChunks("一".repeat(700), source, { maxChars: 320 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(first[0].scope, "card/user");
  assert.equal(createMemoryChunks("不同内容", source).length, 1);
  assert.notEqual(first[0].id, createMemoryChunks("二".repeat(700), source, { maxChars: 320 })[0].id);
});

test("missing provenance produces no chunks", () => {
  assert.deepEqual(createMemoryChunks("内容", null), []);
  assert.deepEqual(createMemoryChunks("内容", { sourceId: "x" }), []);
});
