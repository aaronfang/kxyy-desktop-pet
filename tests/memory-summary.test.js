import test from "node:test";
import assert from "node:assert/strict";
import { buildGlobalMemoryProjection, buildSourceRollingSummary, compareMemoryRecallWithSummary, groupMemoryByTopic } from "../src/ai/memory-summary.js";

test("source summary preserves provenance and bounded time markers", () => {
  const summary = buildSourceRollingSummary([
    { sourceId: "s1", observedAt: 10, text: "事实一" },
    { sourceId: "s2", observedAt: 20, text: "事实二", conflictKey: "city", uncertain: true },
  ]);
  assert.match(summary.text, /\[s1\|10\]/);
  assert.deepEqual(summary.sourceIds, ["s1", "s2"]);
  assert.equal(summary.itemCount, 2);
  assert.deepEqual(summary.conflictKeys, ["city"]);
  assert.equal(summary.uncertainCount, 1);
  assert.match(summary.text, /\[s2\|20\]\?/);
});

test("source summary fails closed for untrusted rows and marks truncation", () => {
  const summary = buildSourceRollingSummary([{ sourceId: "s", text: "x".repeat(500) }, { sourceId: "s2", text: "later" }], { maxChars: 120 });
  assert.ok(summary.text.length <= 120);
  assert.equal(summary.truncated, true);
  assert.equal(buildSourceRollingSummary([{ text: "no provenance" }]).itemCount, 0);
});

test("offline comparison reports only aggregate hit and character deltas", () => {
  const report = compareMemoryRecallWithSummary([{ relevantIds: ["a"], recalled: [{ id: "a", sourceId: "s", observedAt: 1, text: "命中" }, { id: "x", sourceId: "s2", text: "无关" }] }]);
  assert.equal(report.caseCount, 1);
  assert.equal(report.baselineHits, 1);
  assert.equal(report.summaryHits, 1);
  assert.equal(typeof report.charDelta, "number");
  assert.equal(report.text, undefined);
});

test("topic projection is bounded, rebuildable and preserves conflict aggregates", () => {
  const groups = groupMemoryByTopic([{ topic: "工作", sourceId: "s1", conflictKey: "role" }, { topics: ["工作", "生活"], sourceId: "s2", uncertain: true }]);
  assert.deepEqual(groups[0], { topic: "工作", sourceIds: ["s1", "s2"], itemCount: 2, conflictCount: 1, uncertainCount: 1 });
  assert.equal(groups[1].topic, "生活");
});

test("global projection is aggregate-only and bounded", () => {
  assert.deepEqual(buildGlobalMemoryProjection([{ topic: "工作", sourceIds: ["s1", "s2"], itemCount: 2, conflictCount: 1, uncertainCount: 0 }, { topic: "生活", sourceIds: ["s2"], itemCount: 1, conflictCount: 0, uncertainCount: 1 }]), { topicCount: 2, sourceCount: 2, itemCount: 3, conflictCount: 1, uncertainCount: 1 });
});
