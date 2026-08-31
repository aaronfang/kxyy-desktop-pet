import test from "node:test";
import assert from "node:assert/strict";
import { routeMemoryTopics } from "../src/ai/memory-topic-route.js";

test("topic routing is deterministic, deduplicated and bounded", () => {
  const routed = routeMemoryTopics([{ id: "a", topics: ["工作", "工作"] }, { id: "b", topic: "生活" }, { id: "a", topic: "工作" }]);
  assert.deepEqual(routed, [{ topic: "工作", chunkIds: ["a"] }, { topic: "生活", chunkIds: ["b"] }]);
});

test("topic routing ignores empty labels and caps topic/list counts", () => {
  const routed = routeMemoryTopics(Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, topics: ["", `t${i}`] })), { maxTopics: 2, maxPerTopic: 1 });
  assert.equal(routed.length, 2);
  assert.deepEqual(routed.map((item) => item.chunkIds.length), [1, 1]);
});
