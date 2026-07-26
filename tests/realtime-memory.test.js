import test from "node:test";
import assert from "node:assert/strict";

import {
  REALTIME_MEMORY_TIMEOUT_MS,
  formatRealtimeMemoryHints,
  recallRealtimeMemory,
} from "../src/realtime-memory.js";

test("realtime memory formatting keeps the bounded internal hint shape", () => {
  const prompt = formatRealtimeMemoryHints([
    { kind: "fact", text: "普通动态事实", confidence: 0.9, pinned: false },
    { kind: "commitment", text: "下次提醒我带伞", confidence: 0.8, pinned: false },
    { kind: "fact", text: "置顶偏好", confidence: 1, pinned: true },
    { kind: "episode", text: "不应超过条数", confidence: 1, pinned: false },
  ]);
  assert.match(prompt, /通话开始时可用的内部记忆线索/);
  assert.match(prompt, /\[待兑现约定\].*下次提醒我带伞/);
  assert.match(prompt, /\[事实\]\[置顶\] 置顶偏好/);
  assert.equal((prompt.match(/^- \[/gm) || []).length, 3);
  assert.doesNotMatch(prompt, /不应超过条数/);
});

test("realtime memory formatting marks uncertain items and respects character budget", () => {
  const prompt = formatRealtimeMemoryHints(
    [{ kind: "fact", text: "一二三四五六", confidence: 0.4, pinned: false }],
    { maxChars: 5 },
  );
  assert.equal(prompt, "");
  const uncertain = formatRealtimeMemoryHints([
    { kind: "fact", text: "最近在准备面试", confidence: 0.4, pinned: false },
  ]);
  assert.match(uncertain, /\[不确定\]/);
});

test("recall timeout and provider failure degrade to no hints", async () => {
  const timedOut = await recallRealtimeMemory(
    () => new Promise((resolve) => setTimeout(() => resolve({ items: [{ text: "late" }] }), 20)),
    { cardId: "card", nickname: "元宝", query: "" },
    { timeoutMs: 1 },
  );
  assert.deepEqual(timedOut, []);
  const failed = await recallRealtimeMemory(
    async () => {
      throw new Error("locked");
    },
    { cardId: "card", nickname: "元宝", query: "" },
  );
  assert.deepEqual(failed, []);
});

test("recall adapter sends the existing Tauri memory_recall command", async () => {
  const calls = [];
  const items = await recallRealtimeMemory(async (...args) => {
    calls.push(args);
    return { items: [{ kind: "commitment", text: "提醒" }] };
  }, { cardId: "card-a", nickname: "元宝", query: "面试", maxItems: 3 });
  assert.deepEqual(items, [{ kind: "commitment", text: "提醒" }]);
  assert.equal(calls[0][0], "memory_recall");
  assert.deepEqual(calls[0][1].request, {
    cardId: "card-a",
    nickname: "元宝",
    query: "面试",
    maxItems: 3,
  });
  assert.equal(REALTIME_MEMORY_TIMEOUT_MS, 120);
});
