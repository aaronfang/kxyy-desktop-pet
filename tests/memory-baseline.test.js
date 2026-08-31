import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMemoryRecallBaseline } from "../src/ai/memory-baseline.js";
import { MEMORY_BASELINE_FIXTURE } from "./fixtures/memory-baseline.js";

test("baseline fixture reports bounded recall and source coverage", () => {
  const report = evaluateMemoryRecallBaseline([
    { prompt: "用户喜欢茶", latencyMs: 10, relevantIds: ["f1"], recalled: [{ id: "f1", text: "喜欢茶", sourceId: "e1" }] },
    { prompt: "最近经历", latencyMs: 30, relevantIds: ["e1"], recalled: [{ id: "e1", text: "完成面试", occurredAt: 1 }, { id: "x", text: "无关" }] },
  ]);
  assert.equal(report.caseCount, 2);
  assert.equal(report.totalItems, 3);
  assert.equal(report.sourceCompleteness, 2 / 3);
  assert.equal(report.p95LatencyMs, 30);
  assert.equal(report.maxInjectedChars, 6);
  assert.ok(report.irrelevantRate > 0);
});

test("baseline input is capped and fail-closed", () => {
  const report = evaluateMemoryRecallBaseline(Array.from({ length: 100 }, () => ({ recalled: [] })));
  assert.equal(report.caseCount, 64);
  assert.equal(report.totalItems, 0);
  assert.equal(report.irrelevantRate, 0);
});

test("the shipped fixture covers the M0 memory boundary set", () => {
  assert.equal(MEMORY_BASELINE_FIXTURE.length, 8);
  assert.deepEqual(MEMORY_BASELINE_FIXTURE.map((item) => item.name), ["preference", "relationship", "episode", "commitment", "conflict", "expired", "private", "scope-isolation"]);
  const report = evaluateMemoryRecallBaseline(MEMORY_BASELINE_FIXTURE);
  assert.equal(report.caseCount, 8);
  assert.ok(report.sourceCompleteness > 0.8);
});
