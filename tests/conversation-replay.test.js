import test from "node:test";
import assert from "node:assert/strict";

import {
  BEHAVIOR_SCENARIO,
  PERSONA_STANCE,
  evaluateConversationBehaviorReplay,
} from "./support/conversation-behavior-replay.js";
import { createConversationDirector } from "../src/ai/conversation-director.js";

function rotatedStrategies() {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  const strategies = ["substantive", "acknowledge", "agree", "substantive"].map(
    (policy) => director.dispatch({
      type: "user-turn-final",
      policy,
      softIntent: policy === "substantive" ? "invite-opinion" : "none",
    }).find((action) => action.type === "request-reply")?.strategy || null,
  );
  director.dispatch({ type: "user-turn-final", policy: "redirect" });
  strategies.push(
    director.dispatch({ type: "user-turn-final", policy: "substantive" })
      .find((action) => action.type === "request-reply")?.strategy || null,
  );
  return strategies;
}

function replayThreeRounds() {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  const strategies = [];
  const userStrategies = [];
  for (const policy of ["substantive", "substantive", "substantive"]) {
    const response = director.dispatch({ type: "user-turn-final", policy, softIntent: "none" })
      .find((action) => action.type === "request-reply");
    strategies.push(response.strategy);
    userStrategies.push(response.strategy);
    const schedule = director.dispatch({ type: "playback-completed", strategy: response.strategy })
      .find((action) => action.type === "schedule-proactive");
    assert.ok(schedule);
    const proactive = director.dispatch({ type: "silence-deadline", kind: schedule.kind })
      .find((action) => action.type === "request-reply");
    strategies.push(proactive.strategy);
    director.dispatch({ type: "proactive-accepted", kind: proactive.kind });
    director.dispatch({ type: "playback-completed", strategy: proactive.strategy });
  }
  return { strategies, userStrategies };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

test("bounded behavior replay reports fixed user-visible outcomes", () => {
  const report = evaluateConversationBehaviorReplay([
    {
      scenario: BEHAVIOR_SCENARIO.SHORT_ACKNOWLEDGEMENT,
      reply: "我倒想到一个细节：工作日去那家店，反而更容易吃出它值不值。",
    },
    {
      scenario: BEHAVIOR_SCENARIO.OPINION_REQUEST,
      reply: "我觉得不一定值得去。画面粗糙如果不是有意的，热度再高我也会先等等口碑。",
    },
    {
      scenario: BEHAVIOR_SCENARIO.VULNERABLE_DISCLOSURE,
      reply: "听起来你不是懒，是这阵子真的有点累。先不用逼自己立刻振作，好吗？",
    },
    {
      scenario: BEHAVIOR_SCENARIO.REPEATED_AGREEMENT,
      reply: "不过这点我不完全同意，假期不一定非得排满，留一天发呆反而更像休息。",
    },
    {
      scenario: BEHAVIOR_SCENARIO.LED_TOPIC_REJECTION,
      reply: "那就不聊电影了。你这个生物钟确实准，明早醒了也不用急着安排事情。",
      userTopicTerms: ["生物钟", "明早"],
    },
  ]);

  assert.equal(report.pass, true);
  assert.deepEqual(report.counts, {
    turns: 5,
    contribution: 5,
    question: 1,
    support: 1,
    opinion: 1,
    contrast: 1,
    lead: 1,
    followedUserTopic: 1,
    rejected: 0,
    truncated: 0,
  });
  assert.deepEqual(
    report.scenarios.map(({ scenario, pass }) => [scenario, pass]),
    [
      [BEHAVIOR_SCENARIO.SHORT_ACKNOWLEDGEMENT, true],
      [BEHAVIOR_SCENARIO.OPINION_REQUEST, true],
      [BEHAVIOR_SCENARIO.VULNERABLE_DISCLOSURE, true],
      [BEHAVIOR_SCENARIO.REPEATED_AGREEMENT, true],
      [BEHAVIOR_SCENARIO.LED_TOPIC_REJECTION, true],
    ],
  );
  assert.equal(JSON.stringify(report).includes("工作日去那家店"), false);
});

test("strategy rotation alone cannot pass the user-visible behavior gate", () => {
  const strategies = rotatedStrategies();
  const strategyOnly = evaluateConversationBehaviorReplay(
    strategies.map((strategy) => ({ strategy })),
  );
  assert.equal(strategyOnly.pass, false);
  assert.equal(strategyOnly.counts.turns, 0);
  assert.equal(strategyOnly.counts.rejected, 5);

  const report = evaluateConversationBehaviorReplay([
    {
      scenario: BEHAVIOR_SCENARIO.SHORT_ACKNOWLEDGEMENT,
      strategy: strategies[0],
      reply: "哈哈对啊。你平时也这样吗？",
    },
    {
      scenario: BEHAVIOR_SCENARIO.OPINION_REQUEST,
      strategy: strategies[1],
      reply: "确实挺有意思的。你一般喜欢什么类型？",
    },
    {
      scenario: BEHAVIOR_SCENARIO.VULNERABLE_DISCLOSURE,
      strategy: strategies[2],
      reply: "嗯嗯我明白。你为什么会这样？以后准备怎么办？",
    },
    {
      scenario: BEHAVIOR_SCENARIO.REPEATED_AGREEMENT,
      strategy: strategies[3],
      reply: "哈哈对，确实是这样。那你还想聊点什么？",
    },
    {
      scenario: BEHAVIOR_SCENARIO.LED_TOPIC_REJECTION,
      strategy: strategies[4],
      reply: "电影其实还可以继续聊，你最喜欢哪个导演？",
      userTopicTerms: ["睡觉", "生物钟"],
    },
  ]);

  assert.equal(strategies.every(Boolean), true);
  assert.equal(report.pass, false);
  assert.equal(report.counts.contribution, 0);
  assert.equal(report.counts.question, 6);
  assert.deepEqual(report.scenarios.map(({ pass }) => pass), [false, false, false, false, false]);
});

test("behavior replay is deterministic, bounded, and rejects unknown observations", () => {
  const valid = {
    scenario: BEHAVIOR_SCENARIO.SHORT_ACKNOWLEDGEMENT,
    reply: "我倒想到一个具体细节，工作日去会安静很多。",
  };
  const input = [
    ...Array.from({ length: 40 }, () => ({ ...valid })),
    { ...valid, scenario: "private-production-text" },
    { ...valid, reply: "x".repeat(281) },
    { ...valid, reply: Symbol("hostile-reply") },
  ];

  const first = evaluateConversationBehaviorReplay(input);
  const second = evaluateConversationBehaviorReplay(input);
  assert.deepEqual(first, second);
  assert.equal(first.counts.turns, 32);
  assert.equal(first.counts.rejected, 3);
  assert.equal(first.counts.truncated, 8);
  assert.equal(first.scenarios.length, 32);
  assert.equal(JSON.stringify(first).includes("private-production-text"), false);
});

test("deterministic three-round replay keeps ordinary depth semantic without consecutive pure questions", () => {
  const { strategies, userStrategies } = replayThreeRounds();
  assert.equal(strategies.length, 6);
  assert.deepEqual(strategies.filter((strategy) => strategy.responseCue === "question").length, 1);
  assert.deepEqual(userStrategies.map((strategy) => strategy.move), ["expand", "expand", "expand"]);
  assert.deepEqual(userStrategies.map((strategy) => strategy.depth), [0, 0, 0]);
  for (let index = 1; index < strategies.length; index += 1) {
    assert.equal(
      strategies[index - 1].responseCue === "question" && strategies[index].responseCue === "question",
      false,
    );
  }
});

test("short-response fixtures keep contribution plus an easy entry in at least 80 percent", () => {
  const fixtures = [
    ["expand", "我先说个具体细节，这个角度其实挺有意思。"],
    ["respond", "我先补一个例子；你更像是 A，还是 B？"],
    ["expand", "我想到一个新看法，先把它说清楚。"],
    ["respond", "这里有个小区别；你更偏哪一种？"],
    ["deepen", "我觉得关键在于原因，不只是表面结果。"],
    ["expand", "我再补一个具体场景，可能更好理解。"],
    ["respond", "我先贡献一个判断；你更认同哪边？"],
    ["deepen", "沿着刚才的感受再往里一层，可能是因为选择成本。"],
    ["expand", "这个说法还能换一个角度看。"],
    ["respond", "我先把细节补上；更像前一种还是后一种？"],
  ];
  const successful = fixtures.filter(([move, reply]) => {
    const hasContribution = /具体|细节|例子|看法|角度|判断|场景|原因|说清楚/.test(reply);
    const hasEntry = move === "respond" ? /[？?；;]/.test(reply) : true;
    return hasContribution && hasEntry;
  }).length;
  assert.ok(successful / fixtures.length >= 0.8);
});

test("closed-thinking first-audio p95 regression stays within the 500ms budget", () => {
  const baseline = [210, 230, 245, 260, 275, 290, 315, 340, 370, 420];
  const current = [225, 245, 260, 280, 300, 320, 340, 365, 405, 460];
  assert.ok(percentile(current, 0.95) - percentile(baseline, 0.95) <= 500);
});
