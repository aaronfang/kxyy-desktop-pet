import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelSharedExperienceProactiveWork,
  createSharedExperienceProactiveDirector,
  createSharedExperienceProactiveRunner,
  isSharedExperienceProactiveReply,
  resolveSharedExperienceProactiveConfig,
} from "../src/ai/shared-experience-proactive.js";

function snapshot(contentMode, evidenceJournal) {
  return { contentMode, evidenceJournal };
}

test("co-viewing initiative is opt-in and uses fixed frequency schedules", () => {
  assert.deepEqual(resolveSharedExperienceProactiveConfig({}), {
    enabled: false,
    frequency: "standard",
    firstDelayMs: 30_000,
    minIntervalMs: 60_000,
  });
  assert.deepEqual(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "low",
  }), {
    enabled: true,
    frequency: "low",
    firstDelayMs: 60_000,
    minIntervalMs: 120_000,
  });
  assert.deepEqual(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "frequent",
  }), {
    enabled: true,
    frequency: "frequent",
    firstDelayMs: 20_000,
    minIntervalMs: 30_000,
  });
  assert.equal(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "custom-5ms",
  }).frequency, "standard");
});

test("narrated co-viewing speaks from fresh ASR evidence, never from elapsed time alone", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0,
    firstDelayMs: 30_000,
    minIntervalMs: 45_000,
  });

  assert.deepEqual(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", []) }), {
    offered: false,
    reason: "no-new-evidence",
  });

  const evidenceJournal = [
    { id: "ev-1", kind: "visual", atMs: 29_000, text: "昏暗走廊里有一扇门。" },
    { id: "ev-2", kind: "audio", atMs: 30_000, text: "解说说先把灯打开，再从右边绕过去。" },
  ];
  assert.deepEqual(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", evidenceJournal) }), {
    offered: true,
    reason: "narration-event",
    evidenceIds: ["ev-2"],
  });
  assert.deepEqual(director.offer({ atMs: 80_000, snapshot: snapshot("narrated", evidenceJournal) }), {
    offered: false,
    reason: "pending",
  });

  director.complete({ spoken: true, text: "原来开灯是为了从右边绕过去。", atMs: 31_000 });
  assert.deepEqual(director.offer({ atMs: 80_000, snapshot: snapshot("narrated", evidenceJournal) }), {
    offered: false,
    reason: "no-new-evidence",
  });
});

test("low-speech games need a fresh visual sequence and suppress repeated frames", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 10_000, minIntervalMs: 30_000 });
  const journal = [
    { id: "ev-1", kind: "visual", atMs: 8_000, text: "玩家站在昏暗走廊里。" },
    { id: "ev-2", kind: "visual", atMs: 10_000, text: "玩家举枪后退，躲到木箱后面。" },
  ];
  assert.deepEqual(director.offer({ atMs: 10_000, snapshot: snapshot("low-speech-game", journal) }), {
    offered: true,
    reason: "visual-change",
    evidenceIds: ["ev-1", "ev-2"],
  });
  director.complete({ spoken: true, text: "这一下后退找掩体挺及时。", atMs: 11_000 });

  const repeated = [
    ...journal,
    { id: "ev-3", kind: "visual", atMs: 40_000, text: "玩家举枪后退，躲到木箱后面。" },
    { id: "ev-4", kind: "visual", atMs: 41_000, text: "玩家举枪后退，躲到木箱后面。" },
  ];
  assert.deepEqual(director.offer({ atMs: 41_000, snapshot: snapshot("low-speech-game", repeated) }), {
    offered: false,
    reason: "repeated-evidence",
  });
});

test("user activity, pause, hidden UI and active work suppress an otherwise eligible comment", () => {
  const cases = [
    ["user-active", { userActive: true }],
    ["paused", { paused: true }],
    ["hidden", { hidden: true }],
    ["busy", { busy: true }],
    ["speaking", { speaking: true }],
  ];
  for (const [reason, state] of cases) {
    const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 10 });
    const result = director.offer({
      atMs: 100,
      snapshot: snapshot("narrated", [
        { id: "ev-1", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" },
      ]),
      ...state,
    });
    assert.deepEqual(result, { offered: false, reason });
  }
});

test("cancelled reservations do not consume evidence and successful comments enforce cooldown", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 10, minIntervalMs: 100 });
  const first = snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 10, text: "解说说门后面可能还有一只怪物。" },
  ]);
  assert.equal(director.offer({ atMs: 10, snapshot: first }).offered, true);
  director.cancel("user-active");
  assert.equal(director.offer({ atMs: 11, snapshot: first }).offered, true);
  director.complete({ spoken: true, text: "门后这一下确实得提防。", atMs: 12 });

  const second = snapshot("narrated", [
    ...first.evidenceJournal,
    { id: "ev-2", kind: "audio", atMs: 50, text: "解说说钥匙已经拿到了。" },
  ]);
  assert.deepEqual(director.offer({ atMs: 50, snapshot: second }), { offered: false, reason: "cooldown" });
  assert.equal(director.offer({ atMs: 112, snapshot: second }).offered, true);
  assert.deepEqual(director.snapshot(), {
    offered: 3,
    completed: 1,
    failed: 0,
    cancelled: 1,
    lastSpokenAtMs: 12,
    pending: true,
    consumedEvidence: 1,
    suppressions: { "user-active": 1, paused: 0, hidden: 0, busy: 0, speaking: 0, cooldown: 1, "no-new-evidence": 0, "repeated-evidence": 0, "not-meaningful": 0, pending: 0 },
  });
});

test("a rejected generated comment consumes its candidate instead of retrying it in a loop", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 100 });
  const evidence = snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 10, text: "解说说他们决定从侧门进入。" },
  ]);
  assert.equal(director.offer({ atMs: 10, snapshot: evidence }).offered, true);
  assert.equal(director.complete({ spoken: false, atMs: 11 }), false);
  assert.deepEqual(director.offer({ atMs: 12, snapshot: evidence }), { offered: false, reason: "cooldown" });
  assert.deepEqual(director.offer({ atMs: 111, snapshot: evidence }), { offered: false, reason: "no-new-evidence" });
  assert.equal(director.snapshot().failed, 1);
});

test("runner emits one grounded candidate and records its bounded TTS receipt", async () => {
  let now = 100;
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 10 });
  const calls = [];
  const runner = createSharedExperienceProactiveRunner({
    director,
    nowMs: () => now,
    currentState: () => ({}),
    generate: async (candidate) => {
      calls.push(candidate);
      now = 105;
      return { emitted: true, text: "从侧门走这步还挺稳。", ttsReceipt: { status: "completed", totalMs: 800 } };
    },
  });
  const evidence = snapshot("narrated", [
    { id: "ev-7", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" },
  ]);

  const result = await runner.consider(evidence);

  assert.equal(result.started, true);
  assert.deepEqual(calls[0].evidenceIds, ["ev-7"]);
  assert.equal(calls[0].reason, "narration-event");
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(runner.snapshot().events, [{
    atMs: 105,
    reason: "narration-event",
    evidenceIds: ["ev-7"],
    status: "completed",
    textChars: 10,
    tts: { status: "completed", totalMs: 800 },
  }]);
});

test("runner cancellation aborts generation and leaves evidence available", async () => {
  let release;
  let calls = 0;
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 10 });
  const runner = createSharedExperienceProactiveRunner({
    director,
    nowMs: () => 100,
    currentState: () => ({}),
    generate: ({ signal }) => new Promise((resolve) => {
      calls += 1;
      if (calls > 1) { resolve({ emitted: true, text: "侧门这步挺稳。" }); return; }
      signal.addEventListener("abort", () => resolve({ emitted: false }), { once: true });
      release = resolve;
    }),
  });
  const evidence = snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" },
  ]);
  const pending = runner.consider(evidence);
  assert.equal(runner.cancel("user-active"), true);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(runner.snapshot().director.cancelled, 1);
  assert.equal((await runner.consider(evidence)).started, true);
  release?.({ emitted: false });
});

test("stopping co-viewing output clears speech even after proactive generation becomes inactive", () => {
  let stopped = 0;
  const cancelled = cancelSharedExperienceProactiveWork({
    runner: { cancel: () => false },
    reason: "stopped",
    stopOutput: () => { stopped += 1; },
    stopOutputWhenIdle: true,
  });

  assert.equal(cancelled, false);
  assert.equal(stopped, 1);
});

test("routine cancellation does not interrupt unrelated speech when no proactive work is active", () => {
  let stopped = 0;
  cancelSharedExperienceProactiveWork({
    runner: { cancel: () => false },
    reason: "user-active",
    stopOutput: () => { stopped += 1; },
  });
  assert.equal(stopped, 0);
});

test("runner failures consume the rejected evidence and wait for new content", async () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 10 });
  const evidence = snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" },
  ]);
  const runner = createSharedExperienceProactiveRunner({
    director,
    nowMs: () => 100,
    currentState: () => ({}),
    generate: async () => { throw new Error("provider failed"); },
  });
  assert.equal((await runner.consider(evidence)).emitted, false);
  assert.equal(runner.snapshot().director.failed, 1);
  assert.deepEqual(await runner.consider(evidence), { started: false, reason: "cooldown" });
});

test("proactive reply gate keeps natural comments and rejects questions or evidence-audit speech", () => {
  assert.equal(isSharedExperienceProactiveReply("这一下躲进掩体挺及时，晚半秒都悬。"), true);
  for (const invalid of [
    "你觉得他接下来会去哪？",
    "声音说他开灯了，画面显示他还在走廊。",
    "具体是什么还没揭晓。",
    "这点我还没看明白，先不乱猜。",
    "回答你刚才的问题，我觉得他是在找出口。",
    "这个问题的答案应该是他想绕过去。",
    "第一句。第二句。第三句。",
    "长".repeat(121),
  ]) assert.equal(isSharedExperienceProactiveReply(invalid), false, invalid);
});
