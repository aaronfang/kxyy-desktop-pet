const STATUS_ORDER = new Map([["expired", 0], ["active", 2], ["in_progress", 2], ["paused", 3], ["blocked", 3], ["completed", 4], ["done", 4], ["cancelled", 5]]);

export function filterGoals(goals, filters = {}) {
  const list = Array.isArray(goals) ? goals : [];
  return list.filter((goal) => {
    if (filters.kind && goal.kind !== filters.kind) return false;
    if (filters.status && goal.status !== filters.status) return false;
    if (filters.source && goal.source !== filters.source) return false;
    if (filters.scope && goal.scope !== filters.scope) return false;
    if (Number.isSafeInteger(filters.beforeMs) && (!Number.isSafeInteger(goal.dueAtMs) || goal.dueAtMs > filters.beforeMs)) return false;
    if (Number.isSafeInteger(filters.afterMs) && (!Number.isSafeInteger(goal.dueAtMs) || goal.dueAtMs < filters.afterMs)) return false;
    return true;
  });
}

export function sortGoals(goals, nowMs = Date.now()) {
  return [...(Array.isArray(goals) ? goals : [])].sort((a, b) => {
    const rank = (goal) => {
      if (Number.isSafeInteger(goal.dueAtMs) && goal.dueAtMs < nowMs && !["completed", "done", "cancelled"].includes(goal.status)) return 0;
      if (Number.isSafeInteger(goal.dueAtMs) && goal.dueAtMs - nowMs <= 7 * 86400000 && !["completed", "done", "cancelled"].includes(goal.status)) return 1;
      return STATUS_ORDER.get(goal.status) ?? 6;
    };
    return rank(a) - rank(b)
      || (a.dueAtMs ?? Number.MAX_SAFE_INTEGER) - (b.dueAtMs ?? Number.MAX_SAFE_INTEGER)
      || (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0)
      || String(a.id).localeCompare(String(b.id));
  });
}
