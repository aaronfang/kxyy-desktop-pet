import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAcceptanceEvidenceFallbackQuestion,
  buildSharedExperienceCleanupReceipt,
  createSharedExperienceRuntimeReceipts,
  normalizeSharedExperienceAcceptancePlan,
  runSharedExperienceAcceptancePlan,
} from "../src/ai/shared-experience-acceptance.js";

test("runtime receipts require successful model responses, not requested settings", () => {
  const receipts = createSharedExperienceRuntimeReceipts();
  receipts.recordVision({ status: "ok", summary: "画面", provider: "mage-vl", model: "mlx-community/Mage-VL-8bit" });
  receipts.recordAsr({ status: "ok", text: "旁白", asrRuntime: { active: "whisper", status: "active" } });
  receipts.recordText({ provider: "DeepSeek", model: "deepseek-v4-flash", completed: true, responseChars: 12, usage: { total: 30 } });
  assert.equal(receipts.snapshot().vision.successfulResponses, 1);
  assert.equal(receipts.snapshot().asr.provider, "whisper");
  assert.equal(receipts.snapshot().text.provider, "deepseek");
  receipts.recordAsr({ status: "error", text: "" });
  receipts.recordFailure("vision");
  assert.equal(receipts.snapshot().asr.failedResponses, 1);
  assert.equal(receipts.snapshot().vision.failedResponses, 1);
  assert.doesNotMatch(JSON.stringify(receipts.snapshot()), /画面|旁白/);
  const sensevoice = createSharedExperienceRuntimeReceipts();
  sensevoice.recordAsr({ status: "ok", text: "", asrRuntime: { active: "sensevoice-sherpa-onnx", status: "active" } });
  assert.equal(sensevoice.snapshot().asr.provider, "sensevoice");
  sensevoice.recordAsr({ status: "ok", text: "", asrRuntime: { active: "whisper-mlx", status: "active" } });
  assert.equal(sensevoice.snapshot().asr.provider, "mixed-or-unknown");
});

test("runtime receipts do not count headers, empty text, or non-running ASR as completed model work", () => {
  const receipts = createSharedExperienceRuntimeReceipts();
  receipts.recordText({ provider: "DeepSeek" });
  receipts.recordText({ provider: "DeepSeek", completed: true, responseChars: 0 });
  receipts.recordAsr({ status: "ok", text: "", asrRuntime: { active: "sensevoice-sherpa-onnx", status: "warming" } });
  receipts.recordVision({ status: "ok", provider: "mage-vl", summary: "" });
  const snapshot = receipts.snapshot();
  assert.equal(snapshot.text.successfulResponses, 0);
  assert.equal(snapshot.text.completedResponses, 0);
  assert.equal(snapshot.asr.successfulResponses, 0);
  assert.equal(snapshot.vision.successfulResponses, 0);
  receipts.recordText({ provider: "DeepSeek", completed: true, responseChars: 4 });
  assert.equal(receipts.snapshot().text.completedResponses, 1);
});

test("acceptance fallback anchors a simple question to the newest useful real event", () => {
  const snapshot = { workspace: { evidenceJournal: [
    { id: "v1", kind: "visual", text: "走廊里有一扇半开的门。" },
    { id: "a1", kind: "audio", text: "解说说怪物怕光。" },
    { id: "a2", kind: "audio", text: "." },
  ] } };
  assert.deepEqual(buildAcceptanceEvidenceFallbackQuestion(snapshot), {
    prompt: "刚才这段解说主要在说什么？",
    topic: "当前内容",
    anchorEventIds: ["a1"],
    maturity: "shallow",
  });
  assert.deepEqual(buildAcceptanceEvidenceFallbackQuestion({ workspace: { evidenceJournal: [] } }), {});
});

test("async question generation respects the wall-clock deadline before sending", async () => {
  for (const generationMs of [5, 30]) {
    let now = 0;
    let sends = 0;
    const report = await runSharedExperienceAcceptancePlan({
      plan: { durationMs: 20, turns: [{ atMs: 1, dynamic: true }] },
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
      questionForTurn: async () => {
        now += generationMs;
        return { prompt: "他们为什么选侧门进去？", topic: "侧门", anchorEventIds: ["a"] };
      },
      sendPrompt: async () => { sends++; return { assistant: "正门有守卫。" }; },
    });
    assert.equal(sends, generationMs === 5 ? 1 : 0);
    if (sends) assert.equal(report.turns[0].questionTopic, "侧门");
  }
});

test("cleanup receipt proves capture stopped and transient media containers were released", () => {
  assert.deepEqual(buildSharedExperienceCleanupReceipt({
    active: false,
    workspace: null,
    spool: null,
  }), {
    captureStopped: true,
    workspaceReleased: true,
    spoolReleased: true,
    pending: 0,
    complete: true,
  });

  assert.deepEqual(buildSharedExperienceCleanupReceipt({
    active: false,
    workspace: {},
    spool: { snapshot: () => ({ pending: 2 }) },
  }), {
    captureStopped: true,
    workspaceReleased: false,
    spoolReleased: false,
    pending: 2,
    complete: false,
  });
});

test("acceptance plan keeps at most 200 ordered, bounded prompts", () => {
  const plan = normalizeSharedExperienceAcceptancePlan({
    durationMs: 1_800_000,
    turns: [
      { atMs: 20_000, prompt: " second " },
      { atMs: -1, prompt: "first" },
      { atMs: 2_000_000, prompt: "last" },
      { atMs: 10, prompt: "" },
    ],
  });

  assert.equal(plan.durationMs, 1_800_000);
  assert.deepEqual(plan.turns, [
    { atMs: 0, prompt: "first" },
    { atMs: 20_000, prompt: "second" },
    { atMs: 1_800_000, prompt: "last" },
  ]);
});

test("acceptance runner is sequential, records lag and waits for the wall-clock boundary", async () => {
  let now = 1_000;
  let inFlight = 0;
  let maxInFlight = 0;
  const sleeps = [];
  const sent = [];
  const report = await runSharedExperienceAcceptancePlan({
    plan: {
      durationMs: 100,
      turns: [
        { atMs: 10, prompt: "one" },
        { atMs: 20, prompt: "two" },
      ],
    },
    nowMs: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    sendPrompt: async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      now += prompt === "one" ? 25 : 5;
      sent.push(prompt);
      inFlight -= 1;
      return { assistant: `reply:${prompt}`, usage: { requests: sent.length } };
    },
    finish: async () => ({ stored: true }),
  });

  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(maxInFlight, 1);
  assert.equal(report.startedAtMs, 1_000);
  assert.equal(report.endedAtMs, 1_100);
  assert.equal(report.durationMs, 100);
  assert.equal(report.turns[0].scheduledAtMs, 10);
  assert.equal(report.turns[0].startedAtMs, 10);
  assert.equal(report.turns[0].responseMs, 25);
  assert.equal(report.turns[1].startedAtMs, 35);
  assert.equal(report.turns[1].scheduleLagMs, 15);
  assert.equal(report.turns[1].assistant, "reply:two");
  assert.deepEqual(report.finalize, { stored: true });
  assert.deepEqual(sleeps, [10, 60]);
});

test("acceptance clock starts only after the readiness hook", async () => {
  let now = 0;
  const report = await runSharedExperienceAcceptancePlan({
    plan: { durationMs: 100, turns: [{ atMs: 10, prompt: "one" }] },
    nowMs: () => now,
    waitForStart: async () => { now = 1000; },
    sleep: async (ms) => { now += ms; },
    sendPrompt: async () => ({ assistant: "reply" }),
    finish: async () => ({ stored: false }),
  });
  assert.equal(report.startedAtMs, 1000);
  assert.equal(report.turns[0].scheduleLagMs, 0);
});

test("acceptance runner records a failed turn and continues", async () => {
  let now = 0;
  let calls = 0;
  const report = await runSharedExperienceAcceptancePlan({
    plan: {
      durationMs: 2,
      turns: [
        { atMs: 0, prompt: "bad" },
        { atMs: 1, prompt: "good" },
      ],
    },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    sendPrompt: async (prompt) => {
      calls += 1;
      if (prompt === "bad") throw new Error("offline");
      return { assistant: "recovered", ttsReceipt: { status: "completed" } };
    },
  });

  assert.equal(calls, 2);
  assert.equal(report.turns[0].ok, false);
  assert.equal(report.turns[0].error, "offline");
  assert.equal(report.turns[1].ok, true);
  assert.equal(report.turns[1].assistant, "recovered");
  assert.deepEqual(report.turns[1].ttsReceipt, { status: "completed" });
});

test("acceptance runner resolves each dynamic question from the current evidence snapshot", async () => {
  let now = 0;
  let evidenceCount = 1;
  const report = await runSharedExperienceAcceptancePlan({
    plan: {
      durationMs: 3,
      turns: [
        { atMs: 0, category: "evidence", dynamic: true },
        { atMs: 1, category: "continuity", dynamic: true },
      ],
    },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    snapshot: () => ({ evidenceCount }),
    questionForTurn: ({ snapshot, index }) => ({
      prompt: `基于 ${snapshot.evidenceCount} 条证据的问题`,
      anchorEventIds: [`ev-${index + 1}`],
      maturity: index ? "connecting" : "shallow",
    }),
    sendPrompt: async () => {
      evidenceCount += 1;
      return { assistant: "回答" };
    },
  });

  assert.deepEqual(report.turns.map((turn) => turn.prompt), ["基于 1 条证据的问题", "基于 2 条证据的问题"]);
  assert.deepEqual(report.turns[0].anchorEventIds, ["ev-1"]);
  assert.equal(report.turns[1].maturity, "connecting");
});

test("acceptance runner skips an unanchored dynamic slot without fabricating a conversation turn", async () => {
  let now = 0;
  const sent = [];
  const report = await runSharedExperienceAcceptancePlan({
    plan: {
      durationMs: 3,
      turns: [
        { atMs: 0, category: "evidence", dynamic: true },
        { atMs: 1, category: "evidence", dynamic: true },
      ],
    },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    questionForTurn: ({ index }) => index === 0
      ? { prompt: "先等等", anchorEventIds: [], maturity: "waiting" }
      : { prompt: "这个人正在做什么？", anchorEventIds: ["ev-1"], maturity: "shallow" },
    sendPrompt: async (prompt) => {
      sent.push(prompt);
      return { assistant: "他正在推开门。" };
    },
  });

  assert.deepEqual(sent, ["这个人正在做什么？"]);
  assert.deepEqual(report.turns.map((turn) => turn.index), [2]);
  assert.equal(report.completedTurns, 1);
  assert.equal(report.skippedTurns, 1);
  assert.deepEqual(report.skippedTurnDetails, [{
    index: 1,
    scheduledAtMs: 0,
    category: "evidence",
    reason: "no-evidence-anchor",
  }]);
});

test("acceptance runner stops admitting turns after the duration deadline", async () => {
  let now = 0;
  const sent = [];
  const report = await runSharedExperienceAcceptancePlan({
    plan: {
      durationMs: 1_000,
      turns: [
        { atMs: 100, prompt: "第一轮" },
        { atMs: 200, prompt: "第二轮" },
        { atMs: 300, prompt: "不应开始" },
      ],
    },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    sendPrompt: async (prompt) => {
      sent.push(prompt);
      now += prompt === "第二轮" ? 900 : 50;
      return { assistant: "收到" };
    },
    finish: async () => ({ stored: true }),
  });

  assert.deepEqual(sent, ["第一轮", "第二轮"]);
  assert.equal(report.stopReason, "duration-deadline");
  assert.equal(report.completedTurns, 2);
  assert.equal(report.skippedTurns, 1);
});
