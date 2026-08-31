const MAX_BUFFER_CHARS = 800;

export function appendMemoryBuffer(state = {}, text, { now = Date.now(), maxChars = 320 } = {}) {
  const limit = Number.isSafeInteger(maxChars) ? Math.min(MAX_BUFFER_CHARS, Math.max(32, maxChars)) : 320;
  const value = String(text || "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const buffer = `${String(state.text || "")}${value}`.slice(-MAX_BUFFER_CHARS);
  const next = { text: buffer, updatedAt: Number.isFinite(now) ? now : Date.now() };
  if (Array.from(buffer).length >= limit) return { state: { text: "", updatedAt: next.updatedAt }, flushed: buffer };
  return { state: next, flushed: "" };
}

export function flushStaleMemoryBuffer(state = {}, { now = Date.now(), staleAfterMs = 30_000 } = {}) {
  const text = String(state.text || "").trim();
  const updatedAt = Number(state.updatedAt);
  if (!text || !Number.isFinite(updatedAt) || !Number.isFinite(now) || now - updatedAt < Math.max(1_000, staleAfterMs)) return { state, flushed: "" };
  return { state: { text: "", updatedAt: now }, flushed: text };
}
