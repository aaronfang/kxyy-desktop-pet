const STORAGE_KEY = "kxyy.shared-experience.latest-raw-v1";
const SCHEMA_VERSION = 1;
const MAX_EVENTS = 2048;
const MAX_EVENT_CHARS = 500;
const MAX_ARCHIVE_CHARS = 480_000;

function cleanText(value, max = MAX_EVENT_CHARS) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

// Only one stopped session is retained in process memory, never persisted.
let latest = null;
const MAX_AGE_MS = 30 * 60_000;
function scopeKey(scope) {
  if (typeof scope?.cardId !== "string" || typeof scope?.nickname !== "string" || !scope.nickname.trim()) return null;
  return JSON.stringify([scope.cardId.trim(), scope.nickname.trim().toLowerCase()]);
}

function sanitizeEvent(event) {
  if (!event || typeof event.id !== "string" || !event.id || typeof event.text !== "string") return null;
  if (!["audio", "visual", "user", "identity", "primer"].includes(event.kind)) return null;
  const text = cleanText(event.text);
  if (!text) return null;
  return {
    id: event.id.slice(0, 80), kind: event.kind === "primer" ? "identity" : event.kind, text,
    ...(Number.isFinite(event.atMs) ? { atMs: event.atMs } : {}),
    ...(Number.isFinite(event.endedAtMs) ? { endedAtMs: event.endedAtMs } : {}),
  };
}

export function saveLatestSharedExperienceRaw(snapshot, { scope, archivedAtMs = Date.now() } = {}) {
  if (!snapshot || !scopeKey(scope)) return false;
  const events = (Array.isArray(snapshot.evidenceJournal) ? snapshot.evidenceJournal : [])
    .slice(-MAX_EVENTS).map(sanitizeEvent).filter(Boolean);
  const archive = {
    schemaVersion: SCHEMA_VERSION, archivedAtMs,
    sessionId: cleanText(snapshot.sessionId, 120),
    contentMode: cleanText(snapshot.contentMode, 40) || "unknown",
    primerTitle: cleanText(snapshot.primer?.title, 160), events,
  };
  if (!archive.sessionId || !events.length || !Number.isFinite(archivedAtMs)) return false;
  while (JSON.stringify(archive).length > MAX_ARCHIVE_CHARS) archive.events.splice(0, Math.max(1, Math.floor(archive.events.length / 4)));
  latest = { key: scopeKey(scope), archive };
  return true;
}

export function loadLatestSharedExperienceRaw({ scope, nowMs = Date.now() } = {}) {
  if (!latest) return null;
  const age = nowMs - latest.archive.archivedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) { latest = null; return null; }
  if (!scopeKey(scope) || latest.key !== scopeKey(scope)) return null;
  return structuredClone(latest.archive);
}

export function clearLatestSharedExperienceRaw() {
  latest = null;
  // Remove legacy persisted raw observations without reading or replaying them.
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* unavailable */ }
  return true;
}

export async function retryLatestSharedExperienceSummary({ scope, summarize, persist, isCurrent }) {
  const archive = loadLatestSharedExperienceRaw({ scope });
  if (!archive) return null;
  const lease = latest;
  const owner = { cardId: scope.cardId, nickname: scope.nickname };
  const result = await summarize(archive);
  if (lease !== latest || !isCurrent() || !loadLatestSharedExperienceRaw({ scope: owner })) return null;
  if (!result?.summary?.trim() || result.degraded) throw new Error("总结未通过审核");
  const stored = await persist({ sessionId: archive.sessionId, summary: result.summary,
    occurredAtMs: archive.archivedAtMs }, owner);
  if (lease !== latest || !isCurrent()) return null;
  return { ...result, stored };
}
