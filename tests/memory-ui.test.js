import test from "node:test";
import assert from "node:assert/strict";

import { asksNotToRemember, memoryHealthState } from "../src/memory-ui.js";

test("recognizes explicit do-not-remember requests without matching ordinary memory talk", () => {
  for (const text of [
    "别记这段",
    "不要保存这个",
    "不用记住这件事",
    "别把刚才的话存下来",
  ]) {
    assert.equal(asksNotToRemember(text), true, text);
  }
  for (const text of ["请记住这件事", "我记得刚才说过", "不要忘记带伞", "聊聊长期记忆"]) {
    assert.equal(asksNotToRemember(text), false, text);
  }
});

test("memory health prioritizes unavailable, errors, skipped jobs and pending jobs", () => {
  assert.equal(memoryHealthState({ available: true, pendingJobs: 0, skippedJobs: 0 }), null);
  assert.deepEqual(memoryHealthState({ available: true, pendingJobs: 2 }), {
    kind: "pending",
    text: "有 2 批会话正在后台巩固或等待重试，不会阻塞聊天和退出。",
  });
  assert.match(memoryHealthState({ available: true, skippedJobs: 1 }).text, /原始内容已按隐私策略清除/);
  assert.match(
    memoryHealthState({ available: true, pendingJobs: 2, lastError: "  Ollama\n未启动  " }).text,
    /Ollama 未启动.*自动重试/,
  );
  assert.match(memoryHealthState({ available: false, lastError: "SQLite locked" }).text, /聊天仍可继续/);
});

test("memory health bounds provider errors before rendering", () => {
  const state = memoryHealthState({ available: true, lastError: "x".repeat(400) });
  assert.equal(state.kind, "error");
  assert.ok(state.text.length < 300);
});
