const SOURCE_TYPES = new Set(["text_chat", "realtime_completed", "fresh_topic", "user_import"]);
const SENSITIVITY = new Set(["normal", "sensitive", "private"]);
const CONSENT = new Set(["allowed", "explicit", "denied", "private_session"]);
const MAX_EXCERPT = 320;
const MAX_EVENTS = 16;

function boundedText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function normalizeMemorySourceCard(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sourceId = boundedText(input.sourceId, 120);
  const sourceType = boundedText(input.sourceType, 40);
  const scope = boundedText(input.scope, 160);
  const observedAt = Number(input.observedAt);
  if (!sourceId || !SOURCE_TYPES.has(sourceType) || !scope || !Number.isSafeInteger(observedAt) || observedAt <= 0) return null;
  const sensitivity = SENSITIVITY.has(input.sensitivity) ? input.sensitivity : "normal";
  const consent = CONSENT.has(input.consent) ? input.consent : "denied";
  if (consent === "denied" || consent === "private_session" || sensitivity === "private") return null;
  if ((sourceType === "realtime_completed" && input.completed !== true) || (sourceType === "fresh_topic" && input.persist !== true)) return null;
  const eventIds = Array.from(new Set(Array.isArray(input.eventIds) ? input.eventIds.map((id) => boundedText(id, 120)).filter(Boolean) : [])).slice(0, MAX_EVENTS);
  return Object.freeze({ sourceId, sourceType, scope, observedAt, validFrom: Number.isSafeInteger(input.validFrom) && input.validFrom > 0 ? input.validFrom : null, validTo: Number.isSafeInteger(input.validTo) && input.validTo > 0 ? input.validTo : null, sensitivity, consent, excerpt: boundedText(input.excerpt, MAX_EXCERPT), eventIds });
}

export function sourceCardIdempotencyKey(card) {
  if (!card?.sourceId || !card?.scope) return null;
  return `${card.scope}:${card.sourceType}:${card.sourceId}`.slice(0, 300);
}

export async function ingestMemorySource({ invoke, card, text, split }) {
  if (typeof invoke !== "function" || typeof split !== "function") return { ok: false, reason: "invalid_adapter" };
  const normalized = normalizeMemorySourceCard(card);
  if (!normalized) return { ok: false, reason: "rejected_source" };
  const chunks = split(text, normalized).map((chunk) => ({ id: chunk.id, chunkIndex: chunk.index, startOffset: chunk.start, endOffset: chunk.end, text: chunk.text }));
  if (!chunks.length) return { ok: false, reason: "empty_source" };
  const result = await invoke("memory_source_card_upsert", { request: { ...normalized, chunks } });
  return result?.ok ? { ok: true, duplicate: result.duplicate === true, chunkCount: chunks.length } : { ok: false, reason: "write_failed" };
}
