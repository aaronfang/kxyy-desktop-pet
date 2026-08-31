const REASONS = new Set(["keyword", "recent", "pinned", "commitment", "context", "entity"]);

export function explainMemoryRecall(item = {}, reason = "context") {
  const safeReason = REASONS.has(reason) ? reason : "context";
  return Object.freeze({ id: String(item.id || "").slice(0, 120), kind: String(item.kind || "unknown").slice(0, 32), sourceId: String(item.sourceId || "").slice(0, 120) || null, sourceType: String(item.sourceType || "").slice(0, 40) || null, occurredAt: Number.isSafeInteger(item.occurredAt) ? item.occurredAt : null, validTo: Number.isSafeInteger(item.validTo) ? item.validTo : null, confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null, reason: safeReason, uncertain: item.uncertain === true });
}
