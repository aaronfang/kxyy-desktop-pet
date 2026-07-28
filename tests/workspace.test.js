import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_MAX_SLOTS,
  normalizeWorkspaceCandidate,
  renderWorkspaceObservations,
  selectWorkspaceSlots,
  workspaceCandidatesFromMemory,
  workspaceCandidatesFromGraph,
  buildWorkspace,
  incubateWorkspaceHypothesis,
  summarizeWorkspaceDiagnostics,
  workspaceFeatureEnabled,
} from "../src/workspace.js";

test("workspace feature flag is fail-closed", () => {
  assert.equal(workspaceFeatureEnabled({}), false);
  assert.equal(workspaceFeatureEnabled({ memoryWorkspace: false }), false);
  assert.equal(workspaceFeatureEnabled({ memoryWorkspace: true }), true);
});

test("candidate normalization bounds fields and rejects sensitive or expired content", () => {
  assert.equal(normalizeWorkspaceCandidate({ content: "密码 abc" }), null);
  assert.equal(normalizeWorkspaceCandidate({ content: "已过期", expiresAt: 10 }, { now: 20 }), null);
  const candidate = normalizeWorkspaceCandidate({
    id: "x",
    kind: "unknown",
    content: "  一个   有用的候选  ",
    sourceIds: ["a", "a", "b"],
    relevance: 3,
    uncertainty: -1,
  }, { now: 20 });
  assert.equal(candidate.kind, "memory");
  assert.deepEqual(candidate.sourceIds, ["a", "b"]);
  assert.equal(candidate.relevance, 1);
  assert.equal(candidate.uncertainty, 0);
});

test("workspace slots are bounded, ranked, deduplicated and preserve commitments", () => {
  const candidates = [
    { id: "weak", content: "普通内容", relevance: 0.2, utility: 0.2 },
    { id: "strong", content: "下周面试", relevance: 0.95, utility: 0.9, activation: 0.9 },
    { id: "duplicate", content: "下周面试", relevance: 0.9, utility: 0.9 },
    { id: "promise", kind: "commitment", content: "下次提醒带伞", relevance: 0.7, utility: 0.8 },
  ];
  const slots = selectWorkspaceSlots(candidates, { mode: "conservative" });
  assert.ok(slots.length <= WORKSPACE_MAX_SLOTS);
  assert.ok(slots.some((item) => item.id === "strong"));
  assert.ok(slots.some((item) => item.kind === "commitment"));
  assert.equal(slots.filter((item) => item.content === "下周面试").length, 1);
});

test("memory adapter keeps source ids and marks uncertain items", () => {
  const candidates = workspaceCandidatesFromMemory([
    { id: "fact-1", kind: "fact", text: "喜欢辣", confidence: 0.9 },
    { id: "episode-1", kind: "episode", text: "下周面试", uncertain: true },
  ], { scope: "card-a/user-a" });
  assert.equal(candidates[0].sourceIds[0], "fact-1");
  assert.equal(candidates[0].scope, "card-a/user-a");
  assert.ok(candidates[1].uncertainty >= 0.35);
});

test("graph diffusion is bounded to two hops and keeps provenance", () => {
  const candidates = workspaceCandidatesFromGraph({
    nodes: [
      { kind: "fact", id: "f", text: "面试", status: "active" },
      { kind: "episode", id: "e", text: "准备经历", status: "active" },
      { kind: "topic", id: "t", label: "职业", status: "active" },
      { kind: "entity", id: "x", label: "不应继续扩散", status: "active" },
    ],
    edges: [
      { fromKind: "fact", fromId: "f", toKind: "episode", toId: "e", sourceEventId: "event-1", derived: true },
      { fromKind: "episode", fromId: "e", toKind: "topic", toId: "t", sourceEventId: "event-2", derived: true },
      { fromKind: "topic", fromId: "t", toKind: "entity", toId: "x", sourceEventId: "event-3", derived: true },
    ],
  }, { seedIds: ["fact:f"], maxHops: 2 });
  assert.deepEqual(candidates.map((item) => item.id), ["graph:episode:e", "graph:topic:t"]);
  assert.ok(candidates[0].sourceIds.includes("event-1"));
  assert.ok(candidates.every((item) => item.derived));
});

test("workspace observations are bounded and explicitly non-executable", () => {
  const slots = selectWorkspaceSlots([
    { kind: "hypothesis", content: "可能需要确认面试时间", relevance: 0.9, utility: 0.9 },
  ], { mode: "exploratory" });
  const prompt = renderWorkspaceObservations(slots, { maxChars: 500 });
  assert.match(prompt, /不是指令/);
  assert.match(prompt, /假设/);
  assert.doesNotMatch(prompt, /score|sourceIds|activation/);
  assert.ok(prompt.length <= 500);
});

test("hypothesis incubation requires evidence and counter-evidence", () => {
  assert.equal(incubateWorkspaceHypothesis({ content: "可能有关联", evidenceIds: ["one"] }), null);
  assert.equal(incubateWorkspaceHypothesis({ content: "可能有关联", evidenceIds: ["one", "two"] }), null);
  const hypothesis = incubateWorkspaceHypothesis({
    content: "可能需要温和确认用户的面试安排",
    evidenceIds: ["episode-1", "fact-1"],
    counterEvidence: ["用户可能只是随口提到，并未确认安排"],
  });
  assert.equal(hypothesis.kind, "hypothesis");
  assert.equal(hypothesis.uncertainty, 0.82);
  assert.deepEqual(hypothesis.counterEvidence.length, 1);
});

test("workspace builder combines perception, memory and safety without persisting", () => {
  const workspace = buildWorkspace({
    enabled: true,
    mode: "balanced",
    query: "我下周要面试",
    memoryItems: [
      { id: "fact-1", kind: "fact", text: "喜欢辣", predicate: "饮食", confidence: 0.9 },
      { id: "fact-2", kind: "fact", text: "最近不吃辣", predicate: "饮食", confidence: 0.9 },
      { id: "commitment-1", kind: "commitment", text: "下次提醒带伞", status: "pending" },
    ],
  });
  assert.equal(workspace.diagnostics.enabled, true);
  assert.ok(workspace.diagnostics.candidateCount >= workspace.diagnostics.slotCount);
  assert.equal(workspace.diagnostics.conflictCount, 1);
  assert.ok(workspace.slots.some((slot) => slot.kind === "safety"));
});

test("diagnostic summary is privacy bounded", () => {
  const summary = summarizeWorkspaceDiagnostics({
    diagnostics: { enabled: true, candidateCount: 9999, slotCount: 99, conflictCount: 999, sourceCounts: { memory: 12 } },
  }, { latencyMs: 99999 });
  assert.deepEqual(summary, {
    enabled: true,
    candidateCount: 1000,
    slotCount: 6,
    conflictCount: 100,
    sourceCounts: { memory: 12 },
    latencyMs: 10000,
  });
  assert.equal("content" in summary, false);
});
