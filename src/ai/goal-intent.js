const EXPLICIT_ACTION = /(?:我想|我要|计划|打算|准备|提醒我|帮我记下|请记住我)(?<action>.{2,100})/u;
const ACTIONABLE = /(?:完成|做到|实现|学会|提交|购买|预约|联系|整理|阅读|练习|坚持|安排|准备好|截止|之前|之前)/u;
const WISH_ONLY = /(?:好想|希望有一天|以后有空|随便说说|也许|可能会|不知道什么时候)/u;

function cleanTitle(value) {
  return String(value || "").replace(/[。！？!?]+$/u, "").replace(/^(?:去|要去|帮我|请)/u, "").trim().slice(0, 120);
}

function stableKey(text, kind) {
  const normalized = `${kind}:${String(text || "").replace(/\s+/gu, " ").trim().toLowerCase()}`;
  let hash = 2166136261;
  for (const char of normalized) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return `goal-suggestion-${(hash >>> 0).toString(16)}`;
}

export function suggestGoalFromMessage(message) {
  const text = String(message || "").replace(/\s+/gu, " ").trim();
  if (!text || text.length > 240 || WISH_ONLY.test(text)) return null;
  const match = text.match(EXPLICIT_ACTION);
  if (!match || !ACTIONABLE.test(match.groups?.action || "")) return null;
  const title = cleanTitle(match.groups.action);
  if (title.length < 2) return null;
  const kind = /(?:提醒我|帮我记下|请记住我)/u.test(text) ? "todo" : "long_term_goal";
  return Object.freeze({ kind, title, source: "chat_confirmation", sourceMessageId: stableKey(text, "message"), idempotencyKey: stableKey(title, kind), confidence: "explicit" });
}

export function confirmGoalSuggestion(candidate, { title, dueAtMs = null, reminderPolicy = "manual_only" } = {}) {
  if (!candidate || candidate.confidence !== "explicit") return null;
  const finalTitle = cleanTitle(title || candidate.title);
  if (finalTitle.length < 2) return null;
  return Object.freeze({ ...candidate, title: finalTitle, dueAtMs: Number.isSafeInteger(dueAtMs) && dueAtMs > 0 ? dueAtMs : null, reminderPolicy, confirmed: true });
}
