const EXPLICIT_COMPLETION = /(?:完成了|做完了|已经完成|不用了|不需要了)/u;
const THIRD_PARTY = /(?:别人说|他说|她说|朋友说|系统提示)/u;

export function suggestGoalCompletion(message, goals = []) {
  const text = String(message || "").replace(/\s+/gu, " ").trim();
  if (!text || text.length > 240 || THIRD_PARTY.test(text) || !EXPLICIT_COMPLETION.test(text)) return null;
  const normalized = text.replace(EXPLICIT_COMPLETION, "").replace(/[，。！？!?、]/gu, " ").trim();
  const match = (Array.isArray(goals) ? goals : []).find((goal) => {
    const title = String(goal?.title || "").trim();
    return title && (text.includes(title) || normalized.includes(title));
  });
  const status = /(?:不用了|不需要了)/u.test(text) ? (match.kind === "todo" ? "cancelled" : "cancelled") : (match.kind === "todo" ? "done" : "completed");
  return match ? Object.freeze({ goalId: match.id, status, confirmationRequired: true }) : null;
}
