const STORAGE_KEY = "kxyy.fresh-exposure.v1";
export const FRESH_EXPOSURE_SCHEMA_VERSION = 1;
export const FRESH_EXPOSURE_MAX_ENTRIES = 64;
export const FRESH_EXPOSURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OUTCOMES = new Set(["shared", "rejected"]);

function hash32(value, seed) {
  let hash = seed >>> 0;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function opaqueFingerprint(value) {
  const first = hash32(value, 0x811c9dc5);
  const second = hash32(value, 0x9e3779b9);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function fallbackFatigueKey(candidate) {
  const rawTitle = String(candidate?.freshTopic?.title || candidate?.title || "");
  const namedSubject = rawTitle.match(/《([^》]{1,48})》/)?.[1] || "";
  const title = (namedSubject || rawTitle)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 64);
  const category = String(candidate?.freshCategory || candidate?.category || "other").slice(0, 32);
  return title ? `${category}:${title}` : "";
}

export function freshExposureFingerprint(candidate) {
  const sourceId = String(candidate?.freshSourceId || candidate?.sourceId || "").slice(0, 96);
  const category = String(candidate?.freshCategory || candidate?.category || "").slice(0, 32);
  const fatigueKey = String(candidate?.fatigueKey || fallbackFatigueKey(candidate)).slice(0, 96);
  if (!sourceId || !category) return "";
  return opaqueFingerprint(`${category}\u001f${sourceId}\u001f${fatigueKey}`);
}

function safeEntry(entry, nowMs) {
  const fingerprint = typeof entry?.fingerprint === "string" && /^[0-9a-f]{16}$/.test(entry.fingerprint)
    ? entry.fingerprint
    : "";
  const outcome = OUTCOMES.has(entry?.outcome) ? entry.outcome : "";
  const at = Number(entry?.at);
  if (!fingerprint || !outcome || !Number.isFinite(at) || at > nowMs || nowMs - at > FRESH_EXPOSURE_TTL_MS) return null;
  return { fingerprint, outcome, at: Math.trunc(at) };
}

function prune(entries, nowMs) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const safe = safeEntry(entry, nowMs);
    if (!safe || seen.has(safe.fingerprint)) continue;
    seen.add(safe.fingerprint);
    result.push(safe);
  }
  result.sort((left, right) => left.at - right.at);
  return result.slice(-FRESH_EXPOSURE_MAX_ENTRIES);
}

export function createFreshExposureLedger({ nowMs = Date.now(), entries = [] } = {}) {
  return {
    schemaVersion: FRESH_EXPOSURE_SCHEMA_VERSION,
    entries: prune(entries, nowMs),
  };
}

export function loadFreshExposureLedger(storage = globalThis.localStorage, { nowMs = Date.now() } = {}) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return createFreshExposureLedger({ nowMs });
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== FRESH_EXPOSURE_SCHEMA_VERSION) return createFreshExposureLedger({ nowMs });
    return createFreshExposureLedger({ nowMs, entries: parsed.entries });
  } catch {
    return createFreshExposureLedger({ nowMs });
  }
}

export function persistFreshExposureLedger(storage = globalThis.localStorage, ledger, { nowMs = Date.now() } = {}) {
  try {
    const safe = createFreshExposureLedger({ nowMs, entries: ledger?.entries });
    storage?.setItem(STORAGE_KEY, JSON.stringify(safe));
    if (ledger && typeof ledger === "object") ledger.entries = safe.entries;
    return true;
  } catch {
    return false;
  }
}

export function isFreshExposureSuppressed(ledger, candidate, { nowMs = Date.now() } = {}) {
  const fingerprint = freshExposureFingerprint(candidate);
  if (!fingerprint) return false;
  const entries = prune(ledger?.entries, nowMs);
  return entries.some((entry) => entry.fingerprint === fingerprint);
}

export function recordFreshExposure(ledger, candidate, { outcome = "shared", nowMs = Date.now() } = {}) {
  if (!ledger || !OUTCOMES.has(outcome)) return false;
  const fingerprint = freshExposureFingerprint(candidate);
  if (!fingerprint) return false;
  const entries = prune(ledger.entries, nowMs).filter((entry) => entry.fingerprint !== fingerprint);
  entries.push({ fingerprint, outcome, at: Math.trunc(nowMs) });
  ledger.entries = entries.slice(-FRESH_EXPOSURE_MAX_ENTRIES);
  return true;
}

export function recordFreshExposureFingerprint(ledger, fingerprint, { outcome = "shared", nowMs = Date.now() } = {}) {
  if (!ledger || !OUTCOMES.has(outcome) || !/^[0-9a-f]{16}$/.test(String(fingerprint || ""))) return false;
  const entries = prune(ledger.entries, nowMs).filter((entry) => entry.fingerprint !== fingerprint);
  entries.push({ fingerprint, outcome, at: Math.trunc(nowMs) });
  ledger.entries = entries.slice(-FRESH_EXPOSURE_MAX_ENTRIES);
  return true;
}

export { STORAGE_KEY as FRESH_EXPOSURE_STORAGE_KEY };
