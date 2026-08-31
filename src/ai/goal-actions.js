const ACTIONS = new Set(["cancel", "delete", "forget"]);

export function planGoalAction(goal, action) {
  if (!goal || !goal.id || !ACTIONS.has(action)) return null;
  if (action === "cancel") return Object.freeze({ action, goalId: String(goal.id), goalStatus: "cancelled", memory: null });
  if (action === "delete") return Object.freeze({ action, goalId: String(goal.id), goalStatus: null, memory: null });
  const sourceRef = goal.source === "memory_commitment" && goal.sourceRef ? String(goal.sourceRef).slice(0, 120) : null;
  return Object.freeze({ action, goalId: String(goal.id), goalStatus: null, memory: sourceRef ? { kind: "commitment", id: sourceRef } : null });
}
