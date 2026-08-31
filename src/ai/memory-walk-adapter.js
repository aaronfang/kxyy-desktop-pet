export async function recallByEntityWalk({ invoke, enabled = false, scope, entity, from, to, maxItems = 8 } = {}) {
  if (!enabled || typeof invoke !== "function" || !scope || !entity) return [];
  try {
    const rows = await invoke("memory_entity_walk", { scope, entity, from: Number.isSafeInteger(from) ? from : null, to: Number.isSafeInteger(to) ? to : null, maxItems: Math.min(16, Math.max(1, maxItems)) });
    return Array.isArray(rows) ? rows.slice(0, 16).map((row) => ({ id: row.chunkId, text: String(row.text || "").slice(0, 320), sourceId: row.sourceId, sourceType: row.sourceType, occurredAt: row.observedAt })) : [];
  } catch (_) { return []; }
}
