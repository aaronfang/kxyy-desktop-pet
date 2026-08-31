import { buildSourceRollingSummary } from "./memory-summary.js";

export function selectMemorySummary({ enabled = false, items = [], maxChars = 600 } = {}) {
  if (!enabled) return { mode: "recall", text: "", sourceIds: [] };
  try {
    const summary = buildSourceRollingSummary(items, { maxChars });
    if (!summary.text || summary.itemCount === 0) return { mode: "recall", text: "", sourceIds: [] };
    return { mode: "summary", text: summary.text, sourceIds: summary.sourceIds };
  } catch (_) {
    return { mode: "recall", text: "", sourceIds: [] };
  }
}
