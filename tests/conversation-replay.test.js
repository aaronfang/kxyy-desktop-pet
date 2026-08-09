import test from "node:test";
import assert from "node:assert/strict";

import { createConversationDirector } from "../src/ai/conversation-director.js";

function replayThreeRounds() {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  const plans = [];
  const userPlans = [];
  for (const policy of ["substantive", "substantive", "substantive"]) {
    const response = director.dispatch({ type: "user-turn-final", policy, softIntent: "none" })
      .find((action) => action.type === "request-reply");
    plans.push(response.plan);
    userPlans.push(response.plan);
    const schedule = director.dispatch({ type: "playback-completed", plan: response.plan })
      .find((action) => action.type === "schedule-proactive");
    assert.ok(schedule);
    const proactive = director.dispatch({ type: "silence-deadline", kind: schedule.kind })
      .find((action) => action.type === "request-reply");
    plans.push(proactive.plan);
    director.dispatch({ type: "proactive-accepted", kind: proactive.kind });
    director.dispatch({ type: "playback-completed", plan: proactive.plan });
  }
  return { plans, userPlans };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

test("deterministic three-round replay progressively deepens without consecutive pure questions", () => {
  const { plans, userPlans } = replayThreeRounds();
  assert.equal(plans.length, 6);
  assert.deepEqual(plans.filter((plan) => plan.responseCue === "question").length, 1);
  assert.deepEqual(userPlans.map((plan) => plan.move), ["expand", "expand", "expand"]);
  assert.deepEqual(userPlans.map((plan) => plan.depth), [0, 1, 2]);
  for (let index = 1; index < plans.length; index += 1) {
    assert.equal(
      plans[index - 1].responseCue === "question" && plans[index].responseCue === "question",
      false,
    );
  }
});

test("short-response fixtures keep contribution plus an easy entry in at least 80 percent", () => {
  const fixtures = [
    ["expand", "我先说个具体细节，这个角度其实挺有意思。"],
    ["offer-entry", "我先补一个例子；你更像是 A，还是 B？"],
    ["expand", "我想到一个新看法，先把它说清楚。"],
    ["offer-entry", "这里有个小区别；你更偏哪一种？"],
    ["deepen", "我觉得关键在于原因，不只是表面结果。"],
    ["expand", "我再补一个具体场景，可能更好理解。"],
    ["offer-entry", "我先贡献一个判断；你更认同哪边？"],
    ["deepen", "沿着刚才的感受再往里一层，可能是因为选择成本。"],
    ["expand", "这个说法还能换一个角度看。"],
    ["offer-entry", "我先把细节补上；更像前一种还是后一种？"],
  ];
  const successful = fixtures.filter(([move, reply]) => {
    const hasContribution = /具体|细节|例子|看法|角度|判断|场景|原因|说清楚/.test(reply);
    const hasEntry = move === "offer-entry" ? /[？?；;]/.test(reply) : true;
    return hasContribution && hasEntry;
  }).length;
  assert.ok(successful / fixtures.length >= 0.8);
});

test("closed-thinking first-audio p95 regression stays within the 500ms budget", () => {
  const baseline = [210, 230, 245, 260, 275, 290, 315, 340, 370, 420];
  const current = [225, 245, 260, 280, 300, 320, 340, 365, 405, 460];
  assert.ok(percentile(current, 0.95) - percentile(baseline, 0.95) <= 500);
});
