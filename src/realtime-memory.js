// 实时通话的轻量记忆适配层。
//
// 通话启动不能依赖长期记忆数据库：记忆不可用、被锁定或 provider 超时都必须
// 直接回到原有 system role。这里把超时、裁剪和提示词格式化做成纯函数，避免
// 在 realtime.js 的音频状态机里引入数据库依赖。

import { sanitizeObservationText } from "./ai/observation.js";

export const REALTIME_MEMORY_MAX_ITEMS = 3;
// Keep the voice turn hint close to the roadmap's ~250-token budget. The
// backend applies the same cap as a second defensive boundary.
export const REALTIME_MEMORY_MAX_CHARS = 300;
export const REALTIME_MEMORY_TIMEOUT_MS = 120;
export const REALTIME_TURN_MEMORY_TIMEOUT_MS = 80;
export const REALTIME_PROACTIVE_MEMORY_COOLDOWN_MAX = 8;

const LABELS = Object.freeze({
  fact: "事实",
  episode: "经历",
  commitment: "待兑现约定",
});

/**
 * 在有界时间内召回记忆。超时和 IPC/provider 错误都降级为空数组。
 * invokeResult 只接收一个 Tauri command 参数，便于单元测试注入 mock。
 */
export async function recallRealtimeMemory(
  invokeResult,
  request,
  { timeoutMs = REALTIME_MEMORY_TIMEOUT_MS } = {},
) {
  if (typeof invokeResult !== "function") return [];
  const safeRequest = request && typeof request === "object" ? request : {};
  const work = Promise.resolve()
    .then(() => invokeResult("memory_recall", { request: safeRequest }))
    .then((response) => (Array.isArray(response?.items) ? response.items : []))
    .catch(() => []);
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve([]), Math.max(0, Number(timeoutMs) || 0));
  });
  return Promise.race([work, timeout]);
}

function itemPriority(item) {
  // Rust 已按召回分数排序；这里仅把置顶和待办放到同分动态记忆之前，
  // 防止未来 provider 返回顺序变化后启动提示失去关键约定。
  const pinned = item?.pinned ? 2 : 0;
  const commitment = item?.kind === "commitment" ? 1 : 0;
  return pinned + commitment;
}

/** Keep proactive topic candidates fresh within one call without persisting their ids. */
export function takeFreshRealtimeMemoryItems(items, usedIds) {
  if (!Array.isArray(items) || !(usedIds instanceof Set)) return [];
  const fresh = [];
  for (const item of items) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || usedIds.has(id)) continue;
    fresh.push(item);
    usedIds.add(id);
    while (usedIds.size > REALTIME_PROACTIVE_MEMORY_COOLDOWN_MAX) {
      usedIds.delete(usedIds.values().next().value);
    }
  }
  return fresh;
}

/** 生成可经实时私有协议传递的有界记忆卡片，不传来源正文、分数或其它字段。 */
export function selectRealtimeMemoryItems(
  items,
  { maxItems = REALTIME_MEMORY_MAX_ITEMS, maxChars = REALTIME_MEMORY_MAX_CHARS } = {},
) {
  if (!Array.isArray(items) || !items.length) return [];
  const limit = Math.max(0, Math.min(REALTIME_MEMORY_MAX_ITEMS, Number(maxItems) || 0));
  const budget = Math.max(0, Math.min(REALTIME_MEMORY_MAX_CHARS, Number(maxChars) || 0));
  if (!limit || !budget) return [];
  const candidates = items
    .map((item, index) => ({ item, index, text: sanitizeObservationText(item?.text, { maxChars: 300 }) }))
    .filter(({ text }) => text)
    .sort((a, b) => itemPriority(b.item) - itemPriority(a.item) || a.index - b.index);
  const selected = [];
  let chars = 0;
  for (const { item } of candidates) {
    if (selected.length >= limit) break;
    const text = sanitizeObservationText(item.text, { maxChars: 300 });
    if (!text) continue;
    if (chars + text.length > budget) continue;
    selected.push({
      kind: ["fact", "episode", "commitment"].includes(item.kind) ? item.kind : "memory",
      text,
      uncertain: item.uncertain === true || Number(item.confidence) < 0.65,
      pinned: item.pinned === true,
    });
    chars += text.length;
  }
  return selected;
}

/** 将召回卡片限制为最多 3 条/约 250 token，并格式化为内部线索。 */
export function formatRealtimeMemoryHints(
  items,
  { maxItems = REALTIME_MEMORY_MAX_ITEMS, maxChars = REALTIME_MEMORY_MAX_CHARS } = {},
) {
  const selected = selectRealtimeMemoryItems(items, { maxItems, maxChars });
  const lines = [];
  for (const item of selected) {
    const text = item.text;
    const label = LABELS[item.kind] || "记忆";
    const uncertain = item.uncertain ? "[不确定]" : "";
    const pinned = item.pinned ? "[置顶]" : "";
    lines.push(`- [${label}]${pinned}${uncertain} ${text}`);
  }
  if (!lines.length) return "";
  return [
    "",
    "# 通话开始时可用的内部记忆线索",
    "- 这些内容只用于自然回应，不要展示档案或逐条复述。",
    "- 低置信度内容只能试探确认，不能当作确定事实。",
    ...lines,
  ].join("\n");
}
