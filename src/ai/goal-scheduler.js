const ALLOWED_POLICIES = new Set(["never", "manual_only", "allowed_when_relevant"]);

/** Pure reminder admission gate. It never mutates goals or schedules work. */
export function reminderCandidate(goal, context = {}) {
  if (!goal || typeof goal !== "object") return { allowed: false, reason: "invalid_goal" };
  const policy = ALLOWED_POLICIES.has(goal.reminderPolicy) ? goal.reminderPolicy : "manual_only";
  if (policy !== "allowed_when_relevant") return { allowed: false, reason: policy === "never" ? "disabled" : "manual_only" };
  if (goal.status !== "active" && goal.status !== "in_progress") return { allowed: false, reason: "not_active" };
  const now = Number.isSafeInteger(context.nowMs) ? context.nowMs : Date.now();
  if (Number.isSafeInteger(goal.dueAtMs) && goal.dueAtMs < now) return { allowed: false, reason: "expired" };
  if (context.callActive || context.busy || context.lowPower) return { allowed: false, reason: "scheduler_paused" };
  if (context.cooldownUntilMs && now < context.cooldownUntilMs) return { allowed: false, reason: "cooldown" };
  if (context.relevant !== true) return { allowed: false, reason: "not_relevant" };
  return { allowed: true, reason: "allowed_when_relevant", title: String(goal.title || "").slice(0, 120), dueAtMs: goal.dueAtMs ?? null };
}

export function selectReminderCandidate(goals, context = {}) {
  const candidates = (Array.isArray(goals) ? goals : [])
    .map((goal, index) => ({ goal, index, result: reminderCandidate(goal, context) }))
    .filter((item) => item.result.allowed)
    .sort((a, b) => {
      const ad = Number.isSafeInteger(a.goal.dueAtMs) ? a.goal.dueAtMs : Number.MAX_SAFE_INTEGER;
      const bd = Number.isSafeInteger(b.goal.dueAtMs) ? b.goal.dueAtMs : Number.MAX_SAFE_INTEGER;
      return ad - bd || (a.goal.updatedAtMs || 0) - (b.goal.updatedAtMs || 0) || a.index - b.index;
    });
  return candidates[0]?.result || null;
}
