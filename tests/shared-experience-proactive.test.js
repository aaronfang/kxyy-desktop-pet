import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelSharedExperienceProactiveWork,
  createSharedExperienceProactiveDirector,
  createSharedExperienceProactiveRunner,
  isSharedExperienceProactiveReply,
  resolveSharedExperienceProactiveConfig,
  sharedExperienceProactiveDiagnostics,
  sharedExperienceProactiveGroundingPrompt,
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
    jitterMs: 0,
  });
  assert.deepEqual(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "low",
  }), {
    enabled: true,
    frequency: "low",
    firstDelayMs: 60_000,
    minIntervalMs: 120_000,
    jitterMs: 30_000,
  });
  assert.deepEqual(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "frequent",
  }), {
    enabled: true,
    frequency: "frequent",
    firstDelayMs: 20_000,
    minIntervalMs: 20_000,
    jitterMs: 8_000,
  });
  assert.equal(resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "custom-5ms",
  }).frequency, "standard");
});

test("proactive grounding asks for analysis before evidence recitation", () => {
  const initial = sharedExperienceProactiveGroundingPrompt();
  assert.match(initial, /人物选择、处境、动机或局势/);
  assert.match(initial, /分析占主体/);
  assert.match(initial, /至少一半/);
  assert.match(initial, /至少给出一个解释、评价或有依据的推断/);
  assert.match(initial, /不要只报幕或复述/);
  assert.match(initial, /不要先复述/);
  assert.match(initial, /自然.*小问题/);
  assert.match(initial, /不要机械复述/);
  assert.match(initial, /先说你的判断/);
  assert.match(initial, /重要节点可以自然多说一两句/);
  assert.match(initial, /声音说了.*画面显示/);
  assert.match(initial, /解说.*主线/);
  assert.match(initial, /不要求.*逐句对应/);
  assert.match(initial, /因果/);

  const followOn = sharedExperienceProactiveGroundingPrompt("follow-on-analysis");
  assert.match(followOn, /换一个角度分析/);
  assert.match(followOn, /每次至少给出一个解释、评价或有依据的推断/);
  assert.match(followOn, /问题必须依附/);
  assert.match(followOn, /不要把问题单独当成发言/);
  assert.match(followOn, /不要重复上一条评论/);
  assert.match(followOn, /不要编造新进展/);
  assert.match(sharedExperienceProactiveGroundingPrompt("initial-orientation"), /第一次主动回应/);
});

test("restarted proactive sessions warm up before offering the opening orientation", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 10_000,
    warmupMinEvents: 2, initialOrientation: true,
  });
  const first = [{ id: "ev-1", kind: "audio", atMs: 1_000, text: "解说说队伍进入地下城并寻找出口。" }];
  assert.deepEqual(director.offer({ atMs: 10_000, snapshot: snapshot("narrated", first) }), {
    offered: false, reason: "warmup",
  });
  const journal = [...first, { id: "ev-2", kind: "audio", atMs: 11_000, text: "解说说队伍在石门前停下并寻找机关。" }];
  assert.deepEqual(director.offer({ atMs: 12_000, snapshot: snapshot("narrated", journal) }), {
    offered: true, reason: "initial-orientation", evidenceIds: ["ev-1", "ev-2"],
  });
});

test("narrated content keeps the ASR spine while adding nearby visual context", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0,
    firstDelayMs: 0,
    minIntervalMs: 30_000,
  });
  const journal = [
    { id: "visual-1", kind: "visual", atMs: 10_000, text: "镜头里的人举枪后退，躲到门口。" },
    { id: "audio-1", kind: "audio", atMs: 12_000, text: "解说说他准备从侧门突围。" },
  ];
  assert.deepEqual(director.offer({
    atMs: 30_000,
    snapshot: snapshot("narrated", journal),
  }), {
    offered: true,
    reason: "narration-event",
    evidenceIds: ["audio-1", "visual-1"],
  });
});

test("frequent configuration keeps a 20-second minimum and uses bounded jitter", () => {
  const config = resolveSharedExperienceProactiveConfig({
    sharedExperienceProactiveEnabled: true,
    sharedExperienceProactiveFrequency: "frequent",
  });
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0,
    ...config,
    followOnWindowMs: 90_000,
  });
  const evidence = [{ id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" }];
  assert.equal(director.offer({ atMs: 20_000, snapshot: snapshot("narrated", evidence) }).offered, true);
});

test("short-video cadence is faster without changing the selected frequency for long-form content", () => {
  const settings = { sharedExperienceProactiveEnabled: true, sharedExperienceProactiveFrequency: "standard" };
  const short = resolveSharedExperienceProactiveConfig(settings, { contentMode: "short-video" });
  const long = resolveSharedExperienceProactiveConfig(settings, { contentMode: "cinematic" });
  assert.equal(long.minIntervalMs, 60_000);
  assert.ok(short.firstDelayMs < long.firstDelayMs);
  assert.ok(short.minIntervalMs < long.minIntervalMs);
  assert.match(sharedExperienceProactiveGroundingPrompt("", "short-video"), /一两句.*短评/);
  assert.match(sharedExperienceProactiveGroundingPrompt("", "livestream"), /直播.*当下/);
  assert.match(sharedExperienceProactiveGroundingPrompt("", "game-narrated"), /游戏解说.*目标/);
});

test("short-video initiative ignores previous clips and never follows on without fresh evidence", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 12_000, followOnWindowMs: 90_000,
  });
  const journal = [
    { id: "old", kind: "audio", atMs: 1_000, text: "前一个视频讲述一只旧船漂到小岛。" },
    { id: "recent", kind: "visual", atMs: 29_000, text: "新视频里厨师在厨房准备食材。" },
  ];
  assert.deepEqual(director.offer({ atMs: 30_000, snapshot: snapshot("short-video", journal) }), {
    offered: true, reason: "short-video-update", evidenceIds: ["recent"],
  });
  director.complete({ spoken: true, atMs: 31_000 });
  assert.equal(director.offer({ atMs: 95_000, snapshot: snapshot("short-video", journal) }).offered, false);
});

test("changing frequency preserves the live director timeline instead of restarting first delay", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 20_000, minIntervalMs: 20_000, frequency: "frequent",
  });
  const evidence = [{ id: "ev-1", kind: "audio", atMs: 20_000, text: "他决定从侧门进入并继续寻找出口。" }];
  assert.equal(director.offer({ atMs: 20_000, snapshot: snapshot("cinematic", evidence) }).offered, true);
  director.complete({ spoken: true, atMs: 21_000 });
  director.reconfigure({ frequency: "low", firstDelayMs: 60_000, minIntervalMs: 120_000, atMs: 21_000 });
  const state = director.snapshot();
  assert.equal(state.frequency, "low");
  assert.equal(state.nextEligibleAtMs, 140_000);
  assert.equal(state.completed, 1);
});

test("proactive runner records completed speech latency and actual silence gaps", async () => {
  let now = 1_000;
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 100 });
  const runner = createSharedExperienceProactiveRunner({
    director,
    nowMs: () => now,
    generate: async () => {
      now += 250;
      return { emitted: true, text: "这一步改变了局势。", ttsReceipt: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, totalMs: 100, stream: { underrunCount: 0, maxGapMs: 0 } } };
    },
  });
  await runner.consider(snapshot("narrated", [{ id: "ev-1", kind: "audio", atMs: 900, text: "解说说局势发生了变化。" }]));
  now = 2_000;
  await runner.consider(snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 900, text: "解说说局势发生了变化。" },
    { id: "ev-2", kind: "audio", atMs: 1_900, text: "解说说众人决定立刻离开。" },
  ]));
  const diagnostics = sharedExperienceProactiveDiagnostics(runner.snapshot(), 2_500);
  assert.equal(diagnostics.lastSpokenAtMs, 2_250);
  assert.equal(diagnostics.lastSpokenAgoMs, 250);
  assert.equal(diagnostics.lastCompletedIntervalMs, 1_000);
  assert.equal(diagnostics.maxCompletedIntervalMs, 1_000);
  assert.equal(diagnostics.lastTurnDurationMs, 250);
  assert.equal(diagnostics.maxTurnDurationMs, 250);
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
    evidenceIds: ["ev-2", "ev-1"],
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

test("frequent co-viewing waits for its 30-second minimum even after a substantial change", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, earlyIntervalMs: null,
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  const next = { id: "ev-2", kind: "audio", atMs: 18_000, text: "解说说门后出现一个人，他们立刻躲开。" };
  assert.equal(director.offer({ atMs: 14_000, snapshot: snapshot("narrated", [first, next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 20_000, snapshot: snapshot("narrated", [first, next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", [first, next]) }).offered, true);
});

test("frequency is a lower bound: frequent mode does not speak before 30 seconds", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, earlyIntervalMs: null });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  const next = { id: "ev-2", kind: "audio", atMs: 10_000, text: "解说说门后出现一个人，他们立刻躲开。" };
  assert.equal(director.offer({ atMs: 20_999, snapshot: snapshot("narrated", [first, next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", [first, next]) }).offered, true);
});

test("an explicit early hint cannot bypass the configured minimum interval", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0,
    firstDelayMs: 0,
    minIntervalMs: 30_000,
    earlyIntervalMs: 5_000,
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  const second = { id: "ev-2", kind: "audio", atMs: 8_000, text: "解说说门后出现一个人，他们立刻躲开。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  assert.equal(director.offer({ atMs: 20_000, snapshot: snapshot("narrated", [first, second]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", [first, second]) }).offered, true);
});

test("runtime jitter cannot shorten the configured minimum interval", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, jitterMs: 10_000,
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  const next = { id: "ev-2", kind: "audio", atMs: 10_000, text: "解说说门后出现一个人，他们立刻躲开。" };
  assert.equal(director.offer({ atMs: 22_000, snapshot: snapshot("narrated", [first, next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 29_999, snapshot: snapshot("narrated", [first, next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", [first, next]) }).offered, true);
  } finally {
    Math.random = originalRandom;
  }
});

test("frequent cadence always offers by its 30-second deadline when evidence is fresh", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const director = createSharedExperienceProactiveDirector({
      startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, jitterMs: 8_000,
    });
    const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
    assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
    director.complete({ spoken: true, atMs: 1_000 });
    const next = { id: "ev-2", kind: "audio", atMs: 10_000, text: "解说说门后出现一个人，他们立刻躲开。" };
    assert.equal(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", [first, next]) }).offered, true);
  } finally {
    Math.random = originalRandom;
  }
});

test("frequent co-viewing keeps the minimum interval for two fresh events", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, earlyIntervalMs: null,
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  const next = [
    { id: "ev-2", kind: "audio", atMs: 14_000, text: "他们打开侧门发现门后有人。" },
    { id: "ev-3", kind: "audio", atMs: 17_000, text: "那个人开始攻击，他们赶紧躲开。" },
  ];
  assert.equal(director.offer({ atMs: 16_000, snapshot: snapshot("narrated", [first, ...next]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 18_000, snapshot: snapshot("narrated", [first, ...next]) }).reason, "cooldown");
  assert.deepEqual(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", [first, ...next]) }), {
    offered: true, reason: "narration-event", evidenceIds: ["ev-2", "ev-3"],
  });
});

test("frequent cadence can revisit recent evidence for a different angle at the deadline", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, earlyIntervalMs: 15_000,
    followOnWindowMs: 90_000,
  });
  const evidence = [{ id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" }];
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", evidence) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  assert.equal(director.offer({ atMs: 29_999, snapshot: snapshot("narrated", evidence) }).reason, "cooldown");
  assert.deepEqual(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", evidence) }), {
    offered: true, reason: "follow-on-analysis", evidenceIds: ["ev-1"],
  });
  director.complete({ spoken: true, atMs: 32_000 });
  assert.equal(director.offer({ atMs: 122_001, snapshot: snapshot("narrated", evidence) }).reason, "no-new-evidence");
});

test("frequent cadence includes generation and playback time in its 30-second target", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, earlyIntervalMs: 15_000,
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  const second = { id: "ev-2", kind: "audio", atMs: 29_000, text: "解说说他们在门后找到线索。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: true, atMs: 20_000 });
  assert.equal(director.offer({ atMs: 29_999, snapshot: snapshot("narrated", [first, second]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", [first, second]) }).offered, true);
});

test("frequent cadence offers a fresh angle at the 30-second deadline when only recent evidence remains", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, followOnWindowMs: 90_000,
  });
  const evidence = [{ id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" }];
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", evidence) }).offered, true);
  director.complete({ spoken: true, atMs: 2_000 });
  const result = director.offer({ atMs: 32_000, snapshot: snapshot("narrated", evidence) });
  assert.deepEqual(result, {
    offered: true,
    reason: "follow-on-analysis",
    evidenceIds: ["ev-1"],
  });
});

test("a follow-on angle is limited to one reuse of the same evidence batch", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, followOnWindowMs: 90_000,
  });
  const evidence = [{ id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" }];
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", evidence) }).offered, true);
  director.complete({ spoken: true, atMs: 1_000 });
  assert.equal(director.offer({ atMs: 31_000, snapshot: snapshot("narrated", evidence) }).reason, "follow-on-analysis");
  director.complete({ spoken: true, atMs: 32_000 });
  assert.equal(director.offer({ atMs: 62_000, snapshot: snapshot("narrated", evidence) }).reason, "no-new-evidence");
});

test("low-speech games use the cadence deadline for repeated frames instead of going silent", () => {
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
    offered: true,
    reason: "cadence-analysis",
    evidenceIds: ["ev-3", "ev-4"],
  });
});

test("hidden chat permits an evidence-based proactive comment", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1 });
  assert.equal(director.offer({ atMs: 100, hidden: true, snapshot: snapshot("narrated", [
    { id: "ev-1", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" },
  ]) }).offered, true);
});

test("user activity, pause and active work suppress an otherwise eligible comment", () => {
  const cases = [
    ["user-active", { userActive: true }],
    ["paused", { paused: true }],
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
    frequency: "standard",
    firstDelayMs: 10,
    minIntervalMs: 100,
    nextEligibleAtMs: 111,
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

test("long sessions never re-offer evidence after the bounded consumed ledger rolls forward", () => {
  const director = createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 1 });
  const journal = [];
  for (let i = 1; i <= 140; i += 1) {
    journal.push({ id: `ev-${i}`, kind: "audio", atMs: i, text: `解说说第${i}段决定从侧门进入。` });
    const offered = director.offer({ atMs: i, snapshot: snapshot("narrated", journal) });
    assert.equal(offered.offered, true, `event ${i} should be offered once`);
    assert.deepEqual(offered.evidenceIds, [`ev-${i}`], "only the newly arrived event may be selected");
    director.complete({ spoken: false, atMs: i });
  }
  const old = journal.find((event) => event.id === "ev-1");
  const retry = director.offer({ atMs: 1000, snapshot: snapshot("narrated", [old, journal.at(-1)]) });
  assert.deepEqual(retry, { offered: false, reason: "no-new-evidence" });
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
      return { emitted: true, text: "从侧门走这步还挺稳。", ttsReceipt: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 }, totalMs: 800 } };
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
    offeredAtMs: 100,
    turnDurationMs: 5,
    reason: "narration-event",
    evidenceIds: ["ev-7"],
    status: "completed",
    textChars: 10,
    tts: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 }, totalMs: 800 },
  }]);
});

test("proactive playback failure is not completed and failure diagnostics never expose provider text", async () => {
  const cases = [
    [{ emitted: true, text: "从侧门走。", ttsReceipt: { status: "failed" } }, "tts-failed"],
    [{ emitted: true, text: "从侧门走。", ttsReceipt: { status: "partial" } }, "tts-partial"],
    [{ emitted: false, failureReason: "grounding-rejected" }, "grounding-rejected"],
    [{ emitted: false, failureReason: "style-rejected" }, "style-rejected"],
    [{ emitted: false, failureReason: "secret text" }, "no-output"],
    [null, "generation-failed"],
  ];
  for (const [result, reason] of cases) {
    const runner = createSharedExperienceProactiveRunner({
      director: createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1 }), nowMs: () => 100,
      generate: async () => { if (!result) throw new Error("secret text"); return result; },
    });
    const returned = await runner.consider(snapshot("narrated", [{ id: "e", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" }]));
    assert.equal(runner.snapshot().director.completed, 0);
    assert.equal(runner.snapshot().events[0].status, "failed");
    assert.equal(runner.snapshot().events[0].failureReason, reason);
    assert.doesNotMatch(JSON.stringify({ returned, snapshot: runner.snapshot() }), /secret text/);
  }
});

test("proactive speech requires a complete, well-formed streaming playback receipt", async () => {
  const complete = { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 } };
  for (const receipt of [undefined, { ...complete, stream: undefined }, { ...complete, stream: {} },
    { ...complete, stream: { underrunCount: "0", maxGapMs: 0 } },
    { ...complete, stream: { underrunCount: 0, maxGapMs: null } },
    { ...complete, stream: { underrunCount: 1, maxGapMs: 0 } },
    { ...complete, stream: { underrunCount: 0, maxGapMs: 25 } }]) {
    const runner = createSharedExperienceProactiveRunner({
      director: createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1 }),
      nowMs: () => 100,
      generate: async () => ({ emitted: true, text: "从侧门走这步很机灵。", ttsReceipt: receipt }),
    });
    await runner.consider(snapshot("narrated", [{ id: "e", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" }]));
    assert.equal(runner.snapshot().totals.completed, 0);
    assert.equal(runner.snapshot().events[0].status, "failed");
  }
});

test("proactive totals remain complete after bounded event history rolls over", async () => {
  let now = 0;
  const runner = createSharedExperienceProactiveRunner({
    director: createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 0 }),
    nowMs: () => now++, generate: async () => ({ emitted: false, ttsReceipt: { status: "failed" } }),
  });
  const source = snapshot("narrated", [{ id: "e", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" }]);
  for (let index = 0; index < 40; index++) {
    source.evidenceJournal[0] = { ...source.evidenceJournal[0], id: `e-${index}`, atMs: index };
    await runner.consider(source);
  }
  const result = runner.snapshot();
  assert.equal(result.events.length, 32);
  assert.equal(result.totals.failed, 40);
  assert.equal(result.totals.ttsFailed, 40);
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

test("a failed frequent comment does not add a second full cadence delay", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 0, firstDelayMs: 0, minIntervalMs: 30_000, frequency: "frequent",
  });
  const first = { id: "ev-1", kind: "audio", atMs: 0, text: "解说说他们决定从侧门进入。" };
  assert.equal(director.offer({ atMs: 0, snapshot: snapshot("narrated", [first]) }).offered, true);
  director.complete({ spoken: false, atMs: 25_000 });
  const second = { id: "ev-2", kind: "audio", atMs: 26_000, text: "解说说门后又出现了新的线索。" };
  assert.equal(director.offer({ atMs: 29_999, snapshot: snapshot("narrated", [first, second]) }).reason, "cooldown");
  assert.equal(director.offer({ atMs: 30_000, snapshot: snapshot("narrated", [first, second]) }).offered, true);
});

test("proactive diagnostics expose frequency and an exact next eligible timestamp", () => {
  const director = createSharedExperienceProactiveDirector({
    startedAtMs: 1_000, firstDelayMs: 30_000, minIntervalMs: 30_000, frequency: "frequent",
  });
  const state = director.snapshot();
  assert.equal(state.frequency, "frequent");
  assert.equal(state.firstDelayMs, 30_000);
  assert.equal(state.minIntervalMs, 30_000);
  assert.equal(state.nextEligibleAtMs, 31_000);
  assert.deepEqual(sharedExperienceProactiveDiagnostics({
    active: false,
    totals: { completed: 3, failed: 1, cancelled: 2 },
    director: state,
  }, 11_000), {
    frequency: "frequent",
    completed: 3,
    failed: 1,
    cancelled: 2,
    pending: false,
    nextEligibleAtMs: 31_000,
    nextEligibleInMs: 20_000,
    lastSpokenAtMs: 0,
    lastSpokenAgoMs: null,
    lastCompletedIntervalMs: null,
    maxCompletedIntervalMs: null,
    lastTurnDurationMs: null,
    maxTurnDurationMs: null,
    currentSuppressionReason: "",
    currentSuppressionForMs: 0,
    suppressions: state.suppressions,
  });
});

test("viewer silence does not block a later comment about new evidence", async () => {
  let now = 100;
  const spoken = [];
  const runner = createSharedExperienceProactiveRunner({
    director: createSharedExperienceProactiveDirector({ startedAtMs: 0, firstDelayMs: 1, minIntervalMs: 10 }),
    nowMs: () => now,
    generate: async ({ evidenceIds }) => {
      spoken.push(evidenceIds);
      return { emitted: true, text: "这一步绕侧门挺稳。", ttsReceipt: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 } } };
    },
  });
  const first = { id: "ev-1", kind: "audio", atMs: 90, text: "解说说他们决定从侧门进入。" };
  assert.equal((await runner.consider(snapshot("narrated", [first]))).emitted, true);
  now = 111;
  assert.equal((await runner.consider(snapshot("narrated", [first, {
    id: "ev-2", kind: "audio", atMs: 110, text: "解说说他们找到钥匙并打开了门。",
  }]))).emitted, true);
  assert.deepEqual(spoken, [["ev-1"], ["ev-2"]]);
});

test("proactive reply gate keeps natural comments and rejects questions or evidence-audit speech", () => {
  assert.equal(isSharedExperienceProactiveReply("这一下躲进掩体挺及时，晚半秒都悬。"), true);
  assert.equal(isSharedExperienceProactiveReply("他为什么突然生气了？看着不像只是因为那扇门。"), true);
  assert.equal(isSharedExperienceProactiveReply("他刚才还帮着开门，现在却被拦住了。那个人到底是谁啊？"), true);
  assert.equal(isSharedExperienceProactiveReply("刚才那个人是谁啊？"), false);
  assert.equal(isSharedExperienceProactiveReply("他刚才还在犹豫要不要进门，现在主动把门推开了，感觉是终于决定赌一把。可门后那阵动静又让这步显得挺冒险，我都有点替他捏汗。"), true);
  assert.equal(isSharedExperienceProactiveReply("他前面一直绕着这扇门走，刚刚拿到钥匙才折回来，现在又听见门后有动静，才把枪先举起来。这个变化挺有意思的，他不是一味往前冲，而是在试着确认风险。可解说刚说补给已经快用完了，这样拖下去也未必更安全。"), true);
  for (const invalid of [
    "你觉得他接下来会去哪？",
    "声音说他开灯了，画面显示他还在走廊。",
    "具体是什么还没揭晓。",
    "这点我还没看明白，先不乱猜。",
    "回答你刚才的问题，我觉得他是在找出口。",
    "这个问题的答案应该是他想绕过去。",
    "第一句。第二句。第三句。第四句。第五句。",
    "长".repeat(241),
  ]) assert.equal(isSharedExperienceProactiveReply(invalid), false, invalid);
});
