const DEFAULT_CHUNK_CHARS = 320;
const MAX_CHUNK_CHARS = 800;

function hashText(value) {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function splitMemoryText(text, { maxChars = DEFAULT_CHUNK_CHARS } = {}) {
  const limit = Number.isSafeInteger(maxChars) ? Math.min(MAX_CHUNK_CHARS, Math.max(32, maxChars)) : DEFAULT_CHUNK_CHARS;
  const chars = Array.from(String(text || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim());
  const chunks = [];
  for (let start = 0; start < chars.length; start += limit) chunks.push({ text: chars.slice(start, start + limit).join(""), start, end: Math.min(chars.length, start + limit) });
  return chunks;
}

export function createMemoryChunks(text, sourceCard, options = {}) {
  if (!sourceCard?.sourceId || !sourceCard.scope) return [];
  const chunks = splitMemoryText(text, options);
  const sourceFingerprint = `${sourceCard.scope}:${sourceCard.sourceType}:${sourceCard.sourceId}`;
  return chunks.map((chunk, index) => Object.freeze({
    id: `chunk-${hashText(`${sourceFingerprint}:${chunk.text}`)}`,
    index,
    text: chunk.text,
    start: chunk.start,
    end: chunk.end,
    sourceId: sourceCard.sourceId,
    sourceType: sourceCard.sourceType,
    scope: sourceCard.scope,
    observedAt: sourceCard.observedAt,
    eventIds: sourceCard.eventIds,
  }));
}
