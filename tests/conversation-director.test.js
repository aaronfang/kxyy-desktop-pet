import test from "node:test";
import assert from "node:assert/strict";

import {
  CONVERSATION_MOVE,
  RESPONSE_CUE,
  classifyImportantTopicBranch,
  createConversationDirector,
  createSessionTopicLedger,
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
    plan: {
      move: CONVERSATION_MOVE.EXPAND,
      responseCue: RESPONSE_CUE.NONE,
      stance: "companion",
      depth: 0,
    },
  });

  assert.deepEqual(
    onlyAction(director, { type: "playback-completed", plan: first.plan }),
    { type: "schedule-proactive", kind: "followup", delayMs: 4000 },
  );
  const second = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(second.plan.move, CONVERSATION_MOVE.OFFER_ENTRY);
  assert.equal(second.plan.responseCue, RESPONSE_CUE.LOW_BURDEN);
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  assert.equal(
    onlyAction(director, { type: "playback-completed", plan: second.plan }).delayMs,
    6000,
  );

  const third = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(third.plan.move, CONVERSATION_MOVE.EXPAND);
  assert.equal(third.plan.responseCue, RESPONSE_CUE.NONE);
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  const fourth = onlyAction(director, { type: "silence-deadline", kind: "followup" });
  assert.equal(fourth.plan.move, CONVERSATION_MOVE.DEEPEN);
  assert.equal(fourth.plan.responseCue, RESPONSE_CUE.QUESTION);
});

test("two low-interest turns require a same-topic continuation before topic switch", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  director.dispatch({ type: "user-turn-final", policy: "acknowledge", softIntent: "none" });
  let scheduled = onlyAction(director, {
    type: "playback-completed",
    plan: { move: "expand", responseCue: "none", stance: "companion", depth: 0 },
  });
  assert.equal(scheduled.kind, "followup");

  director.dispatch({ type: "user-turn-final", policy: "acknowledge", softIntent: "none" });
  scheduled = onlyAction(director, {
    type: "playback-completed",
    plan: { move: "expand", responseCue: "none", stance: "companion", depth: 0 },
  });
  assert.equal(scheduled.kind, "followup");

  director.dispatch({ type: "silence-deadline", kind: "followup" });
  director.dispatch({ type: "proactive-accepted", kind: "followup" });
  scheduled = onlyAction(director, {
    type: "playback-completed",
    plan: { move: "offer-entry", responseCue: "low-burden", stance: "companion", depth: 0 },
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
      plan: { move: "expand", responseCue: "none", stance: "companion", depth: 0 },
    }),
    [],
  );
  assert.equal(director.snapshot().proactiveTurns, 3);
});

test("soft intents change only the current reply plan", () => {
  const director = createConversationDirector({ mode: "ai-leads" });
  director.dispatch({ type: "session-started" });

  const opinion = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-opinion",
  });
  assert.equal(opinion.plan.move, CONVERSATION_MOVE.EXPAND);
  assert.equal(opinion.plan.stance, "opinion");

  const advice = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-advice",
  });
  assert.equal(advice.plan.stance, "advice");

  const normal = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "none",
  });
  assert.equal(normal.plan.stance, "companion");
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
  assert.deepEqual(action.plan, {
    move: CONVERSATION_MOVE.ASSOCIATE,
    responseCue: RESPONSE_CUE.LOW_BURDEN,
    stance: "companion",
    depth: 0,
  });
  assert.equal(director.snapshot().initiativeDebt, 0);
  assert.equal(director.snapshot().lateralMoves, 1);
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
    }).plan.move);
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
    assert.notEqual(action.plan.move, CONVERSATION_MOVE.ASSOCIATE);
  }

  const [settling] = director.dispatch({
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    lateralAllowed: true,
    topicActivity: "settling",
  });
  assert.equal(settling.plan.move, CONVERSATION_MOVE.ASSOCIATE);
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
  assert.notEqual(sensitive.plan.move, CONVERSATION_MOVE.ASSOCIATE);
  const advice = onlyAction(director, {
    type: "user-turn-final",
    policy: "substantive",
    softIntent: "invite-advice",
    lateralAllowed: true,
  });
  assert.notEqual(advice.plan.move, CONVERSATION_MOVE.ASSOCIATE);
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
  assert.notEqual(firstCalm.plan.move, CONVERSATION_MOVE.ASSOCIATE);
  const secondCalm = onlyAction(director, {
    type: "user-turn-final",
    policy: "agree",
    softIntent: "none",
    lateralAllowed: true,
  });
  assert.equal(secondCalm.plan.move, CONVERSATION_MOVE.ASSOCIATE);
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
    if (action.plan.move === CONVERSATION_MOVE.ASSOCIATE) lateralMoves += 1;
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
  assert.deepEqual(director.dispatch({ type: "playback-completed", plan: null }), []);
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
