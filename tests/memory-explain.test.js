import test from "node:test";
import assert from "node:assert/strict";
import { explainMemoryRecall } from "../src/ai/memory-explain.js";

test("recall explanation is fixed-shape and bounded", () => {
  const result = explainMemoryRecall({ id: "x".repeat(200), kind: "fact", sourceId: "chat-1", sourceType: "text_chat", occurredAt: 10, confidence: 2, text: "敏感正文" }, "keyword");
  assert.equal(result.id.length, 120);
  assert.equal(result.confidence, 1);
  assert.equal(result.reason, "keyword");
  assert.equal(result.text, undefined);
});

test("unknown reasons fail closed", () => {
  assert.equal(explainMemoryRecall({ id: "x" }, "model-inferred").reason, "context");
});
