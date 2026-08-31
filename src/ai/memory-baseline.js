const MAX_BASELINE_ITEMS = 64;

export function evaluateMemoryRecallBaseline(cases = []) {
  const rows = Array.isArray(cases) ? cases.slice(0, MAX_BASELINE_ITEMS) : [];
  let totalItems = 0; let totalChars = 0; let sourceComplete = 0; let irrelevant = 0; const latencies = [];
  for (const item of rows) {
    const recalled = Array.isArray(item.recalled) ? item.recalled : [];
    if (Number.isFinite(item.latencyMs) && item.latencyMs >= 0) latencies.push(item.latencyMs);
    totalItems += recalled.length;
    totalChars += recalled.reduce((sum, value) => sum + String(value?.text || "").length, 0);
    sourceComplete += recalled.filter((value) => value?.sourceId || value?.sourceType || value?.occurredAt).length;
    const relevant = new Set((Array.isArray(item.relevantIds) ? item.relevantIds : []).map(String));
    irrelevant += recalled.filter((value) => relevant.size && !relevant.has(String(value?.id || ""))).length;
  }
  latencies.sort((a, b) => a - b); const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null;
  return Object.freeze({ caseCount: rows.length, totalItems, averageItems: rows.length ? totalItems / rows.length : 0, maxChars: rows.reduce((max, item) => Math.max(max, String(item?.prompt || "").length), 0), totalChars, maxInjectedChars: rows.reduce((max, item) => Math.max(max, (Array.isArray(item?.recalled) ? item.recalled : []).reduce((sum, value) => sum + String(value?.text || "").length, 0)), 0), p95LatencyMs: p95, irrelevantRate: totalItems ? irrelevant / totalItems : 0, sourceCompleteness: totalItems ? sourceComplete / totalItems : 0 });
}
