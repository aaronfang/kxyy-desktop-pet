import test from "node:test";
import assert from "node:assert/strict";
import { confirmGoalSuggestion, suggestGoalFromMessage } from "../src/ai/goal-intent.js";
import { reminderCandidate, selectReminderCandidate } from "../src/ai/goal-scheduler.js";
import { filterGoals, sortGoals } from "../src/ai/goal-view.js";
import { canImplicitlyWriteCommitmentFromGoal, commitmentToGoal } from "../src/ai/goal-commitment.js";
import { suggestGoalCompletion } from "../src/ai/goal-completion.js";
import { planGoalAction } from "../src/ai/goal-actions.js";

test("only explicit actionable language creates a suggestion", () => {
  assert.equal(suggestGoalFromMessage("我好想学会画画"), null);
  assert.equal(suggestGoalFromMessage("以后有空再说，可能会学画画"), null);
  const candidate = suggestGoalFromMessage("我计划今年完成个人网站")
  assert.equal(candidate.kind, "long_term_goal");
  assert.equal(candidate.confidence, "explicit");
  assert.match(candidate.title, /完成个人网站/);
});

test("reminder wording is a TODO and never writes by itself", () => {
  const candidate = suggestGoalFromMessage("提醒我明天提交报销")
  assert.equal(candidate.kind, "todo");
  assert.equal(candidate.confirmed, undefined);
});

test("confirmation is explicit, bounded, and idempotent", () => {
  const candidate = suggestGoalFromMessage("我打算完成季度总结")
  const confirmed = confirmGoalSuggestion(candidate, { title: "完成季度总结", dueAtMs: 1234 });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.reminderPolicy, "manual_only");
  assert.equal(confirmGoalSuggestion(candidate, { title: " " }), null);
  assert.equal(confirmed.idempotencyKey, confirmGoalSuggestion(candidate).idempotencyKey);
});

test("reminder gate is opt-in and pauses for expiry, calls, and cooldown", () => {
  const goal = { title: "提交报销", status: "active", reminderPolicy: "allowed_when_relevant", dueAtMs: 2000, updatedAtMs: 1 };
  assert.equal(reminderCandidate({ ...goal, reminderPolicy: "manual_only" }, { nowMs: 1000, relevant: true }).allowed, false);
  assert.equal(reminderCandidate(goal, { nowMs: 3000, relevant: true }).reason, "expired");
  assert.equal(reminderCandidate(goal, { nowMs: 1000, relevant: true, callActive: true }).reason, "scheduler_paused");
  assert.equal(reminderCandidate(goal, { nowMs: 1000, relevant: true, cooldownUntilMs: 1500 }).reason, "cooldown");
  assert.equal(reminderCandidate(goal, { nowMs: 1000, relevant: true }).allowed, true);
});

test("candidate selection returns at most one, ordered by due date", () => {
  const goals = [
    { title: "later", status: "active", reminderPolicy: "allowed_when_relevant", dueAtMs: 3000 },
    { title: "soon", status: "active", reminderPolicy: "allowed_when_relevant", dueAtMs: 2000 },
  ];
  assert.equal(selectReminderCandidate(goals, { nowMs: 1000, relevant: true }).title, "soon");
  assert.equal(selectReminderCandidate(goals, { nowMs: 1000, relevant: false }), null);
});

test("goal view filtering and sorting are deterministic", () => {
  const goals = [
    { id: "done", status: "done", source: "manual", dueAtMs: 1000 },
    { id: "soon", status: "active", source: "chat_confirmation", dueAtMs: 1500 },
    { id: "late", status: "active", source: "manual", dueAtMs: 900 },
  ];
  assert.deepEqual(sortGoals(goals, 1000).map((g) => g.id), ["late", "soon", "done"]);
  assert.deepEqual(filterGoals(goals, { source: "manual" }).map((g) => g.id), ["done", "late"]);
});

test("commitment conversion preserves a reference and is idempotent", () => {
  const commitment = { id: "commitment-7", text: "下周提交总结", dueAt: 2000 };
  const first = commitmentToGoal(commitment);
  const second = commitmentToGoal(commitment);
  assert.equal(first.source, "memory_commitment");
  assert.equal(first.sourceRef, commitment.id);
  assert.equal(first.id, second.id);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(canImplicitlyWriteCommitmentFromGoal(), false);
  assert.equal(commitmentToGoal({ id: "x", text: "" }), null);
});

test("completion suggestions require explicit wording and confirmation", () => {
  const goals = [{ id: "g1", title: "提交总结", status: "active" }];
  assert.deepEqual(suggestGoalCompletion("我提交总结完成了", goals), { goalId: "g1", status: "completed", confirmationRequired: true });
  assert.equal(suggestGoalCompletion("提交总结不用了", goals)?.status, "cancelled");
  assert.equal(suggestGoalCompletion("应该差不多了", goals), null);
  assert.equal(suggestGoalCompletion("别人说提交总结完成了", goals), null);
});

test("cancel, delete and forget stay separate and forget only targets a commitment source", () => {
  const goal = { id: "g1", source: "memory_commitment", sourceRef: "c1" };
  assert.deepEqual(planGoalAction(goal, "cancel"), { action: "cancel", goalId: "g1", goalStatus: "cancelled", memory: null });
  assert.deepEqual(planGoalAction(goal, "delete"), { action: "delete", goalId: "g1", goalStatus: null, memory: null });
  assert.deepEqual(planGoalAction(goal, "forget"), { action: "forget", goalId: "g1", goalStatus: null, memory: { kind: "commitment", id: "c1" } });
  assert.equal(planGoalAction({ id: "g2", source: "manual" }, "forget").memory, null);
  assert.equal(planGoalAction(goal, "unknown"), null);
});
