import { buildDailyMemoryDigest } from "./memory-daily-digest.js";

export function selectDailyMemoryDigest({ enabled = false, items = [], timezone = "UTC" } = {}) {
  if (!enabled) return { mode: "disabled", days: [] };
  try {
    const days = buildDailyMemoryDigest(items, { timezone });
    return days.length ? { mode: "aggregate", days } : { mode: "empty", days: [] };
  } catch (_) { return { mode: "fallback", days: [] }; }
}
