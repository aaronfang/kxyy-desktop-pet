const MAX_ENTITIES = 128;
const MAX_ALIASES = 12;

export function normalizeEntityName(value) {
  return String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").replace(/[\s\p{P}]+/gu, "").toLowerCase().slice(0, 80);
}

export function createEntityRegistry(entries = []) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries.slice(0, MAX_ENTITIES) : []) {
    const canonical = String(entry?.canonical || "").trim().slice(0, 80);
    const key = normalizeEntityName(canonical);
    if (!key) continue;
    const aliases = Array.from(new Set([canonical, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].map(normalizeEntityName).filter(Boolean))).slice(0, MAX_ALIASES);
    map.set(key, { canonical, aliases });
  }
  return Object.freeze({ resolve(value) { const key = normalizeEntityName(value); if (!key) return null; for (const entity of map.values()) if (entity.aliases.includes(key)) return entity.canonical; return null; }, size: map.size });
}

export function memoryWalk(items = [], { entity, registry, sourceType, from, to, scope, maxItems = 32 } = {}) {
  const canonical = registry?.resolve(entity) || normalizeEntityName(entity);
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (result.length >= Math.min(64, Math.max(1, maxItems))) break;
    if (scope && item?.scope && item.scope !== scope) continue;
    if (sourceType && item?.sourceType && item.sourceType !== sourceType) continue;
    const occurred = Number(item?.occurredAt ?? item?.occurred_at ?? 0);
    if (Number.isFinite(from) && occurred < from) continue;
    if (Number.isFinite(to) && occurred > to) continue;
    const haystack = normalizeEntityName(`${item?.text || ""} ${(item?.entities || []).join(" ")}`);
    if (canonical && !haystack.includes(canonical)) continue;
    result.push(item);
  }
  return result;
}
