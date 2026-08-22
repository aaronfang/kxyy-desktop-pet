import test from "node:test";
import assert from "node:assert/strict";

import {
  CONVERSATION_MOVE,
  PERSONA_STANCE,
  REASONING_POLICY,
  RESPONSE_CUE,
  classifyImportantTopicBranch,
  createRecoveryTurnStrategy,
  createConversationDirector,
  createReasoningPolicyController,
  createSessionTopicLedger,
  normalizeReasoningPreference,
  sanitizeTurnStrategy,
} from "../src/ai/conversation-director.js";

function onlyAction(director, event) {
  const actions = director.dispatch(event);
  assert.equal(actions.length, 1, event.type);
  return actions[0];
}

test("ai-leads rotates contribution and response entry without consecutive questions", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  const first = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
  });
  assert.deepEqual(first, {
    type: "request-reply",
    kind: "response",
    strategy: {
      move: CONVERSATION_MOVE.EXPAND,
      responseCue: RESPONSE_CUE.NONE,
      stance: PERSONA_STANCE.SUPPORT,
      reasoningPolicy: REASONING_POLICY.FAST,
      depth: 0,
    },
  });

  assert.deepEqual(
    onlyAction(director, { type: "playback-completed", strategy: first.strategy }),
    { type: "schedule-proactive", kind: "followup", delayMs: 4000 },
  );
  const second = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(second.strategy.move, CONVERSATION_MOVE.RESPOND);
  assert.equal(second.strategy.responseCue, RESPONSE_CUE.LOW_BURDEN);
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  assert.equal(
    onlyAction(director, { type: "playback-completed", strategy: second.strategy }).delayMs,
    6000,
  );

  const third = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(third.strategy.move, CONVERSATION_MOVE.EXPAND);
  assert.equal(third.strategy.responseCue, RESPONSE_CUE.NONE);
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  const fourth = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(fourth.strategy.move, CONVERSATION_MOVE.DEEPEN);
  assert.equal(fourth.strategy.responseCue, RESPONSE_CUE.QUESTION);
});

test("two low-interest turns require a same-topic continuation before topic switch", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  director.dispatch({ type: "user-turn-final", policy: "acknowledge", softIntent: "none" });
  let scheduled = onlyAction(director, {
    type: "playback-completed",
    strategy: { move: "expand", responseCue: "none", stance: "support", depth: 0 },
  });
  assert.equal(scheduled.kind, "followup");

  director.dispatch({ type: "user-turn-final", policy: "acknowledge", softIntent: "none" });
  scheduled = onlyAction(director, {
    type: "playback-completed",
    strategy: { move: "expand", responseCue: "none", stance: "support", depth: 0 },
  });
  assert.equal(scheduled.kind, "followup");

  director.dispatch({ type: "silence-deadline", kind: "followup" });
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  scheduled = onlyAction(director, {
    type: "playback-completed",
    strategy: { move: "respond", responseCue: "low-burden", stance: "support", depth: 0 },
  });
  assert.deepEqual(scheduled, {
    type: "schedule-proactive",
    kind: "idle",
    delayMs: 14000,
  });
});

test("three accepted proactive turns stop an unanswered monologue", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  director.dispatch({ type: "user-turn-final", policy: "substantive", softIntent: "none" });

  for (let index = 0; index < 3; index += 1) {
    const action = onlyAction(director, { type: "silence-deadline", kind: "followup" });
    assert.equal(action.type, "request-reply");
    director.dispatch({ type: "proactive-accepted", kind: "followup" });
  }

  assert.deepEqual(
    director.dispatch({
      type: "playback-completed",
      strategy: { move: "expand", responseCue: "none", stance: "support", depth: 0 },
    }),
    [],
  );
  assert.equal(director.snapshot().proactiveTurns, 3);
});

test("soft intents change only the current turn strategy", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  const opinion = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-opinion",
  });
  assert.equal(opinion.strategy.move, CONVERSATION_MOVE.EXPAND);
  assert.equal(opinion.strategy.stance, "opine");

  const advice = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-advice",
  });
  assert.equal(advice.strategy.stance, "support");

  const normal = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
  });
  assert.equal(normal.strategy.stance, "support");
});

test("explicit opinion requests opine without turning the reply into an interview", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  const action = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-opinion",
    topicActivity: "neutral",
  });

  assert.equal(action.strategy.stance, PERSONA_STANCE.OPINE);
  assert.equal(action.strategy.responseCue, RESPONSE_CUE.NONE);
});

test("repeated low-information agreement rotates bounded agency on safe topics", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  const stances = Array.from({ length: 3 }, () => onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "settling",
    lateralAllowed: true,
  }).strategy.stance);

  assert.deepEqual(stances, [
    PERSONA_STANCE.SUPPORT,
    PERSONA_STANCE.CONTRAST,
    PERSONA_STANCE.LEAD,
  ]);

  const resetDirector = createConversationDirector({ mode: "balanced" });
  resetDirector.dispatch({ type: "session-started" });
  resetDirector.dispatch({
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "settling",
    lateralAllowed: true,
  });
  resetDirector.dispatch({ type: "hard-control", control: "pause" });
  resetDirector.dispatch({ type: "hard-control", control: "resume" });
  const resumed = onlyAction(resetDirector, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "settling",
    lateralAllowed: true,
  });
  assert.equal(resumed.strategy.stance, PERSONA_STANCE.SUPPORT);
});

test("sensitive disclosures suppress contrast and leadership until calm recovery", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  director.dispatch({
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "settling",
    lateralAllowed: true,
  });

  const sensitive = onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "invite-opinion",
    topicActivity: "sensitive",
    lateralAllowed: true,
  });
  assert.equal(sensitive.strategy.stance, PERSONA_STANCE.SUPPORT);
  assert.notEqual(sensitive.strategy.move, CONVERSATION_MOVE.ASSOCIATE);

  const firstCalm = onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "neutral",
    lateralAllowed: true,
  });
  assert.equal(firstCalm.strategy.stance, PERSONA_STANCE.SUPPORT);
});

test("rejecting a led direction returns the same turn to the user topic", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  for (let index = 0; index < 3; index += 1) {
    director.dispatch({ type: "proactive-window-missed", reason: "asr" });
  }
  const led = onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    topicActivity: "settling",
    lateralAllowed: true,
  });
  assert.equal(led.strategy.stance, PERSONA_STANCE.LEAD);

  const redirected = director.dispatch({
    type: "user-turn-final",
    policy: "redirect",
    softIntent: "none",
    topicActivity: "neutral",
  });
  assert.deepEqual(redirected.at(-1), {
    type: "request-reply",
    kind: "response",
    strategy: {
      move: CONVERSATION_MOVE.RESPOND,
      responseCue: RESPONSE_CUE.NONE,
      stance: PERSONA_STANCE.SUPPORT,
      reasoningPolicy: REASONING_POLICY.FAST,
      depth: 0,
    },
  });
});

test("three missed proactive windows become one in-response lateral association", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  for (let index = 0; index < 3; index += 1) {
    director.dispatch({ type: "proactive-window-missed", reason: "asr" });
  }
  const action = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
    lateralAllowed: true,
  });
  assert.deepEqual(action.strategy, {
    move: CONVERSATION_MOVE.ASSOCIATE,
    responseCue: RESPONSE_CUE.LOW_BURDEN,
    stance: PERSONA_STANCE.LEAD,
    reasoningPolicy: REASONING_POLICY.FAST,
    depth: 0,
  });
  assert.equal(director.snapshot().initiativeDebt, 0);
  assert.equal(director.snapshot().lateralMoves, 1);
});

test("turn strategy schema is fixed and depth is semantic rather than mechanical", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  const ordinary = Array.from({ length: 4 }, () => onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
    topicActivity: "neutral",
  }).strategy);
  assert.deepEqual(ordinary.map(({ depth }) => depth), [0, 0, 0, 0]);

  const deep = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "deepen",
    conversationDepth: 3,
  }).strategy;
  assert.equal(deep.depth, 3);
  assert.equal(deep.move, CONVERSATION_MOVE.DEEPEN);

  const valid = createRecoveryTurnStrategy();
  assert.deepEqual(sanitizeTurnStrategy({ ...valid, privateText: "forbidden" }), valid);
  for (const invalid of [
    { ...valid, move: "offer-entry" },
    { ...valid, stance: "companion" },
    { ...valid, reasoningPolicy: "automatic" },
    { ...valid, responseCue: "two-questions" },
    { ...valid, depth: 4 },
    { ...valid, depth: -1 },
    { ...valid, depth: true },
  ]) assert.equal(sanitizeTurnStrategy(invalid), null);
});

test("reasoning preferences normalize to off automatic or always", () => {
  assert.equal(normalizeReasoningPreference("off"), "off");
  assert.equal(normalizeReasoningPreference("automatic"), "automatic");
  assert.equal(normalizeReasoningPreference("always"), "always");
  assert.equal(normalizeReasoningPreference(true), "always");
  assert.equal(normalizeReasoningPreference(false), "off");
  assert.equal(normalizeReasoningPreference("hostile"), "off");
});

test("automatic reasoning is deliberate only for agreed semantic scenarios", () => {
  const scenarios = [
    ["greeting", { turnCategory: "acknowledge", signal: "none" }, "fast"],
    ["explicit depth", { turnCategory: "substantive", signal: "explicit-depth" }, "deliberate"],
    ["reasons", { turnCategory: "substantive", signal: "reasons" }, "deliberate"],
    ["decision", { turnCategory: "substantive", signal: "decision" }, "deliberate"],
    ["relationship", { turnCategory: "substantive", signal: "relationship" }, "deliberate"],
    ["emotion", { turnCategory: "substantive", signal: "emotion" }, "deliberate"],
    ["comparison", { turnCategory: "substantive", signal: "comparison" }, "deliberate"],
  ];
  for (const [name, event, expected] of scenarios) {
    const controller = createReasoningPolicyController({ preference: "automatic" });
    assert.equal(controller.select(event).policy, expected, name);
  }
});

test("automatic deliberate carry is bounded to two eligible followups and resets on control", () => {
  const controller = createReasoningPolicyController({ preference: "automatic" });
  assert.deepEqual(controller.select({ turnCategory: "substantive", signal: "decision" }), {
    policy: "deliberate",
    source: "automatic-decision",
  });
  assert.equal(controller.select({ turnCategory: "substantive", signal: "none" }).source, "automatic-carry");
  assert.equal(controller.select({ turnCategory: "substantive", signal: "none" }).source, "automatic-carry");
  assert.deepEqual(controller.select({ turnCategory: "substantive", signal: "none" }), {
    policy: "fast",
    source: "automatic-fast",
  });

  controller.select({ turnCategory: "substantive", signal: "relationship" });
  assert.deepEqual(controller.select({ turnCategory: "pause", signal: "none" }), {
    policy: "fast",
    source: "fast-control",
  });
  assert.equal(controller.select({ turnCategory: "substantive", signal: "none" }).policy, "fast");
});

test("off always and proactive control preferences stay deterministic", () => {
  const off = createReasoningPolicyController({ preference: "off" });
  const always = createReasoningPolicyController({ preference: "always" });
  assert.deepEqual(off.select({ turnCategory: "substantive", signal: "decision" }), {
    policy: "fast",
    source: "preference-off",
  });
  assert.deepEqual(always.select({ turnCategory: "substantive", signal: "none" }), {
    policy: "deliberate",
    source: "preference-always",
  });
  assert.deepEqual(always.select({ turnCategory: "proactive", signal: "none" }), {
    policy: "fast",
    source: "fast-control",
  });
  assert.deepEqual(always.select({ turnCategory: "recovery", signal: "none" }), {
    policy: "fast",
    source: "fast-control",
  });
});

test("four eligible reactive turns create a lateral opening without waiting for silence", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  const moves = [];
  for (let index = 0; index < 4; index += 1) {
    moves.push(onlyAction(director, {
      type: "user-turn-final",
      policy: "substantive",
      softIntent: "none",
      lateralAllowed: true,
    }).strategy.move);
  }
  assert.equal(moves.slice(0, 3).includes(CONVERSATION_MOVE.ASSOCIATE), false);
  assert.equal(moves[3], CONVERSATION_MOVE.ASSOCIATE);
});

test("an active topic defers lateral pressure until a settling turn", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  for (let index = 0; index < 5; index += 1) {
    const [action] = director.dispatch({
      type: "user-turn-final",
      policy: "substantive",
      softIntent: "none",
      lateralAllowed: true,
      topicActivity: "active",
    });
    assert.notEqual(action.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
  }

  const [settling] = director.dispatch({
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    lateralAllowed: true,
    topicActivity: "settling",
  });
  assert.equal(settling.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
  assert.equal(director.snapshot().topicActivity.active, 5);
  assert.equal(director.snapshot().topicActivity.settling, 1);
});

test("sensitive turns and explicit intents keep the current topic despite initiative debt", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  for (let index = 0; index < 3; index += 1) {
    director.dispatch({ type: "proactive-window-missed", reason: "asr" });
  }
  const sensitive = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
    lateralAllowed: false,
  });
  assert.notEqual(sensitive.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
  const advice = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-advice",
    lateralAllowed: true,
  });
  assert.notEqual(advice.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
  assert.equal(director.snapshot().initiativeDebt, 3);
});

test("a sensitive turn requires two calm turns before lateral initiative resumes", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  for (let index = 0; index < 3; index += 1) {
    director.dispatch({ type: "proactive-window-missed", reason: "asr" });
  }
  director.dispatch({
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
    lateralAllowed: false,
  });
  const firstCalm = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
    lateralAllowed: true,
  });
  assert.notEqual(firstCalm.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
  const secondCalm = onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    lateralAllowed: true,
  });
  assert.equal(secondCalm.strategy.move, CONVERSATION_MOVE.ASSOCIATE);
});

test("a rapid nineteen-turn chat gets bounded lateral moves instead of nineteen followups", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  let lateralMoves = 0;
  for (let index = 0; index < 19; index += 1) {
    director.dispatch({ type: "proactive-window-missed", reason: "asr" });
    const action = onlyAction(director, {
      type: "user-turn-final",
      policy: "substantive",
      softIntent: "none",
      lateralAllowed: true,
    });
    if (action.strategy.move === CONVERSATION_MOVE.ASSOCIATE) lateralMoves += 1;
  }
  assert.ok(lateralMoves >= 3, `expected several natural openings, got ${lateralMoves}`);
  assert.ok(lateralMoves <= 5, `lateral moves must remain bounded, got ${lateralMoves}`);
});

test("hard controls and hangup cancel leading without retaining text", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });
  assert.deepEqual(director.dispatch({ type: "hard-control", control: "pause" }), [
    { type: "cancel-proactive" },
    { type: "pause-leading" },
  ]);
  assert.deepEqual(director.dispatch({ type: "playback-completed", strategy: null }), []);
  assert.deepEqual(director.dispatch({ type: "hard-control", control: "resume" }), [
    { type: "resume-leading" },
  ]);

  director.dispatch({ type: "user-turn-final", policy: "substantive", softIntent: "none" });
  director.dispatch({ type: "hangup" });
  assert.deepEqual(director.dispatch({ type: "silence-deadline", kind: "followup" }), []);
  assert.deepEqual(director.snapshot(), {
    mode: "ai-leads",
    lifecycle: "stopped",
    paused: true,
    proactiveTurns: 0,
    lowInterestTurns: 0,
    sameTopicContinuations: 0,
    lastMove: "none",
    lastResponseCue: "none",
    depth: 0,
    initiativeDebt: 0,
    topicTurns: 0,
    lateralMoves: 0,
    lateralRecoveryTurns: 0,
    lateralCooldownTurns: 0,
    topicActivity: { active: 0, neutral: 0, settling: 0, sensitive: 0 },
  });
  assert.equal(JSON.stringify(director.snapshot()).includes("substantive"), false);
});

test("important topic branches require explicit personal meaning signals", () => {
  assert.equal(classifyImportantTopicBranch("我最近一直很焦虑，工作这件事反复困扰我"), "emotion");
  assert.equal(classifyImportantTopicBranch("我还没决定要不要换工作，确实挺纠结的"), "decision");
  assert.equal(classifyImportantTopicBranch("我今年的目标是把自己的产品做出来"), "goal");
  assert.equal(classifyImportantTopicBranch("我和家里人的关系最近让我很难受"), "relationship");
  assert.equal(classifyImportantTopicBranch("这个问题困扰我好几年了"), "long-running");

  assert.equal(classifyImportantTopicBranch("今天吃了碗面"), "none");
  assert.equal(classifyImportantTopicBranch("最近天气不错"), "none");
  assert.equal(classifyImportantTopicBranch("刚看了一个电影新闻"), "none");
  assert.equal(classifyImportantTopicBranch("我想吃火锅"), "none");
});

test("session topic ledger is bounded, revisits infrequently, and never snapshots text", () => {
  const ledger = createSessionTopicLedger({ revisitEvery: 5, maxEntries: 8 });
  for (let index = 0; index < 10; index += 1) {
    ledger.observe({
      topicKey: `topic-${index}`,
      category: index % 2 ? "decision" : "goal",
      context: `private branch ${index}`,
    });
  }
  assert.equal(ledger.snapshot().entries, 8);
  assert.equal(JSON.stringify(ledger.snapshot()).includes("private branch"), false);

  for (let index = 1; index < 5; index += 1) {
    const proposal = ledger.proposeTransition();
    assert.equal(proposal.kind, "switch", `transition ${index}`);
    ledger.commitTransition(proposal);
  }
  const revisit = ledger.proposeTransition();
  assert.equal(revisit.kind, "revisit");
  assert.equal(revisit.context, "private branch 2");
  ledger.commitTransition(revisit);

  for (let index = 0; index < 4; index += 1) {
    ledger.commitTransition(ledger.proposeTransition());
  }
  const secondRevisit = ledger.proposeTransition();
  assert.equal(secondRevisit.kind, "revisit");
  assert.notEqual(secondRevisit.topicKey, revisit.topicKey);
  ledger.commitTransition(secondRevisit);
  assert.equal(ledger.snapshot().revisited, 2);
});

test("sealed or already revisited topics are never selected again", () => {
  const ledger = createSessionTopicLedger({ revisitEvery: 1 });
  ledger.observe({ topicKey: "goal-a", category: "goal", context: "第一个长期目标" });
  ledger.seal("goal-a");
  ledger.observe({ topicKey: "goal-b", category: "goal", context: "第二个长期目标" });

  const first = ledger.proposeTransition();
  assert.equal(first.topicKey, "goal-b");
  ledger.commitTransition(first);
  assert.equal(ledger.proposeTransition().kind, "switch");

  ledger.stop();
  assert.deepEqual(ledger.snapshot(), {
    lifecycle: "stopped",
    entries: 0,
    eligible: 0,
    revisited: 0,
    acceptedTransitions: 0,
  });
});

test("same-category paraphrases merge into one revisit candidate", () => {
  const ledger = createSessionTopicLedger();
  ledger.observe({ topicKey: "我最近工作焦虑", category: "emotion", context: "工作让我焦虑" });
  ledger.observe({ topicKey: "我工作压力让我焦虑", category: "emotion", context: "工作压力让我焦虑" });
  assert.equal(ledger.snapshot().entries, 1);
});
