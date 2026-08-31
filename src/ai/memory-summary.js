const MAX_SUMMARY_CHARS = 600;

export function buildSourceRollingSummary(items = [], { maxChars = MAX_SUMMARY_CHARS } = {}) {
  const limit = Number.isSafeInteger(maxChars) ? Math.min(MAX_SUMMARY_CHARS, Math.max(120, maxChars)) : MAX_SUMMARY_CHARS;
  const rows = (Array.isArray(items) ? items : []).filter((item) => item?.text && item?.sourceId).slice(0, 64);
  const lines = []; const conflictKeys = new Set(); let uncertainCount = 0;
  for (const item of rows) {
    if (item.conflictKey) conflictKeys.add(String(item.conflictKey).slice(0, 80));
    if (item.uncertain === true) uncertainCount += 1;
    const line = `[${item.sourceId}|${Number.isFinite(item.observedAt) ? item.observedAt : "unknown"}]${item.uncertain === true ? "?" : ""} ${String(item.text).replace(/\s+/gu, " ").trim()}`;
    if ((lines.join("\n") + (lines.length ? "\n" : "") + line).length > limit) break;
    lines.push(line);
  }
  return Object.freeze({ text: lines.join("\n"), sourceIds: Array.from(new Set(rows.slice(0, lines.length).map((item) => String(item.sourceId)))).slice(0, 16), conflictKeys: Array.from(conflictKeys).slice(0, 16), uncertainCount, itemCount: lines.length, truncated: lines.length < rows.length });
}

export function compareMemoryRecallWithSummary(cases = [], summarize = buildSourceRollingSummary) {
  const rows = Array.isArray(cases) ? cases.slice(0, 64) : [];
  let baselineChars = 0; let summaryChars = 0; let baselineHits = 0; let summaryHits = 0;
  for (const item of rows) {
    const recalled = Array.isArray(item.recalled) ? item.recalled : [];
    const relevant = new Set((Array.isArray(item.relevantIds) ? item.relevantIds : []).map(String));
    baselineChars += recalled.reduce((sum, row) => sum + String(row?.text || "").length, 0);
    baselineHits += recalled.filter((row) => relevant.has(String(row?.id || ""))).length;
    const summary = summarize(recalled);
    summaryChars += String(summary?.text || "").length;
    summaryHits += summary?.sourceIds?.length && relevant.size ? recalled.filter((row) => summary.sourceIds.includes(String(row?.sourceId || "")) && relevant.has(String(row?.id || ""))).length : 0;
  }
  return Object.freeze({ caseCount: rows.length, baselineChars, summaryChars, baselineHits, summaryHits, hitDelta: summaryHits - baselineHits, charDelta: summaryChars - baselineChars });
}

export function groupMemoryByTopic(items = []) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items.slice(0, 128) : []) {
    const topics = Array.isArray(item?.topics) && item.topics.length ? item.topics : [item?.topic];
    for (const topic of topics) {
      const key = String(topic || "").trim().slice(0, 80);
      if (!key) continue;
      const group = groups.get(key) || { topic: key, sourceIds: new Set(), itemCount: 0, conflictCount: 0, uncertainCount: 0 };
      if (item.sourceId) group.sourceIds.add(String(item.sourceId));
      group.itemCount += 1; if (item.conflictKey) group.conflictCount += 1; if (item.uncertain === true) group.uncertainCount += 1;
      groups.set(key, group);
    }
  }
  return Array.from(groups.values()).map((group) => Object.freeze({ topic: group.topic, sourceIds: Array.from(group.sourceIds).slice(0, 16), itemCount: group.itemCount, conflictCount: group.conflictCount, uncertainCount: group.uncertainCount })).slice(0, 64);
}

export function buildGlobalMemoryProjection(topicGroups = []) {
  const groups = Array.isArray(topicGroups) ? topicGroups.slice(0, 64) : [];
  const sources = new Set(); let items = 0; let conflicts = 0; let uncertain = 0;
  for (const group of groups) { for (const source of Array.isArray(group?.sourceIds) ? group.sourceIds.slice(0, 16) : []) sources.add(String(source)); items += Number.isFinite(group?.itemCount) ? Math.max(0, group.itemCount) : 0; conflicts += Number.isFinite(group?.conflictCount) ? Math.max(0, group.conflictCount) : 0; uncertain += Number.isFinite(group?.uncertainCount) ? Math.max(0, group.uncertainCount) : 0; }
  return Object.freeze({ topicCount: groups.length, sourceCount: sources.size, itemCount: items, conflictCount: conflicts, uncertainCount: uncertain });
}
