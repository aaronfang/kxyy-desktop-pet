export function buildDailyMemoryDigest(items = [], { timezone = "UTC", maxDays = 31 } = {}) {
  const days = new Map();
  for (const item of Array.isArray(items) ? items.slice(0, 512) : []) {
    const observed = Number(item?.observedAt);
    if (!Number.isFinite(observed) || !item?.sourceId) continue;
    const day = new Date(observed * 1000).toISOString().slice(0, 10);
    if (!days.has(day) && days.size >= Math.min(31, Math.max(1, maxDays))) continue;
    const bucket = days.get(day) || { date: day, sourceIds: new Set(), itemCount: 0, conflictCount: 0, uncertainCount: 0, timezone };
    bucket.sourceIds.add(String(item.sourceId)); bucket.itemCount += 1; if (item.conflictKey) bucket.conflictCount += 1; if (item.uncertain === true) bucket.uncertainCount += 1; days.set(day, bucket);
  }
  return Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)).map((bucket) => Object.freeze({ date: bucket.date, timezone: bucket.timezone, sourceIds: Array.from(bucket.sourceIds).slice(0, 16), itemCount: bucket.itemCount, conflictCount: bucket.conflictCount, uncertainCount: bucket.uncertainCount }));
}
