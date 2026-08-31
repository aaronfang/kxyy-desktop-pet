import test from "node:test";
import assert from "node:assert/strict";
import { createEntityRegistry, memoryWalk, normalizeEntityName } from "../src/ai/memory-entities.js";

test("entity normalization is deterministic and strips punctuation/spacing", () => {
  assert.equal(normalizeEntityName(" 元元·Yuan Yuan "), "元元yuanyuan");
});

test("registry resolves canonical names and aliases with bounded entries", () => {
  const registry = createEntityRegistry([{ canonical: "元元", aliases: ["元宝", "小元"] }, { canonical: "项目A", aliases: ["项目 A"] }]);
  assert.equal(registry.resolve("元宝"), "元元");
  assert.equal(registry.resolve("项目 A"), "项目A");
  assert.equal(registry.resolve("未知"), null);
  assert.equal(registry.size, 2);
});

test("memory walk filters aliases, source, time window and scope deterministically", () => {
  const registry = createEntityRegistry([{ canonical: "元元", aliases: ["元宝"] }]);
  const items = [
    { id: "a", text: "元元喜欢茶", sourceType: "text_chat", occurredAt: 10, scope: "s" },
    { id: "b", text: "元宝参加活动", sourceType: "realtime_completed", occurredAt: 20, scope: "s" },
    { id: "c", text: "元元旧记录", sourceType: "text_chat", occurredAt: 5, scope: "other" },
  ];
  assert.deepEqual(memoryWalk(items, { entity: "元宝", registry, sourceType: "text_chat", from: 10, to: 10, scope: "s" }).map((item) => item.id), ["a"]);
});
