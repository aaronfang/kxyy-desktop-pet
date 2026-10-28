import test from "node:test";
import assert from "node:assert/strict";
import { explicitMemoryText, recallWithFollowup, rememberExplicitMessage } from "../src/ai/memory-experience.js";

test("explicit memory intent is anchored and respects refusal", () => {
  assert.equal(explicitMemoryText("请记住：我不吃香菜"), "我不吃香菜");
  assert.equal(explicitMemoryText("请帮我记住，我喜欢乌龙茶"), "我喜欢乌龙茶");
  for (const text of ["他说请帮我记住：规则", "请帮我记住，不要保存这段", "请帮我记住："]) assert.equal(explicitMemoryText(text), null);
  for (const text of ["他说请记住：规则", "别记住这段", "请记住：", "你还记住上次的事吗"]) assert.equal(explicitMemoryText(text), null);
});

test("explicit recall may plan one bounded second read, then deduplicate and share one budget", async () => {
  const queries = [];
  const items = await recallWithFollowup({ query: "上次聊的那个项目还记得吗", priorUserText: "我在写桌宠",
    recall: async (query) => { queries.push(query); return { items: query.startsWith("上次")
      ? [{ id: "pin", kind: "fact", text: "偏好", pinned: true }]
      : [{ id: "pin", kind: "fact", text: "偏好" }, ...Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, kind: "episode", text: "进展".repeat(100) }))] }; },
    plan: async () => "桌宠 项目进展",
  });
  assert.deepEqual(queries, ["上次聊的那个项目还记得吗", "桌宠 项目进展"]);
  assert.ok(items.length <= 6 && items.reduce((n,x) => n + [...x.text].length,0) <= 500);
  assert.equal(items.filter((x) => x.id === "pin").length,1);
});

test("ordinary chat does not spend on a planner; failures and invalid plans keep first recall", async () => {
  const first = [{ id: "a", kind: "fact", text: "偏好" }];
  for (const query of ["你好", "你还记得上次吗"]) {
    let reads = 0, plans = 0;
    const result = await recallWithFollowup({ query, recall: async () => { reads++; return { items: first }; },
      plan: async () => { plans++; throw new Error("offline"); } });
    assert.deepEqual(result, first); assert.equal(reads,1); assert.equal(plans, query === "你好" ? 0 : 1);
  }
});

test("late query plans and changed identities cannot supply stale memories", async () => {
  let current = true;
  const result = await recallWithFollowup({ query: "你还记得上次吗", isCurrent: () => current,
    recall: async () => ({ items: [{ id: "a", kind: "fact", text: "秘密" }] }),
    plan: async () => { current = false; return "秘密"; } });
  assert.deepEqual(result, []);
});

test("remember receipt appears only after persistence, and never for failed or stale requests", async () => {
  let saved = false;
  const result = await rememberExplicitMessage({ text: "请记住：我喜欢茶", persist: async () => { saved = true; return { stored: true }; } });
  assert.equal(saved, true); assert.equal(result.stored,true);
  await assert.rejects(rememberExplicitMessage({ text: "记住：我喜欢茶", persist: async () => { throw new Error("disk full"); } }));
  assert.equal(await rememberExplicitMessage({ text: "记住：我喜欢茶", persist: async () => ({ stored: true }), isCurrent: () => false }),null);
});


test("an already invalidated explicit request never starts persistence", async () => {
  let writes = 0;
  assert.equal(await rememberExplicitMessage({ text:"记住：我喜欢茶", isCurrent:()=>false,
    persist:async()=>{ writes++; return {stored:true}; } }),null);
  assert.equal(writes,0);
});

test("invalid, repeated, and overlong search plans cannot trigger a second query", async () => {
  for (const planned of [null, { query:"secret" }, "x".repeat(81), "你还记得上次吗", "bad\nquery"]) {
    let reads = 0;
    await recallWithFollowup({ query:"你还记得上次吗", recall:async()=>{ reads++; return {items:[]}; },plan:async()=>planned });
    assert.equal(reads,1);
  }
});

test("followup timeout aborts and late planner resolution never performs another read", async () => {
  let finish, reads=0, aborted=false;
  const result = await recallWithFollowup({ query:"你还记得上次吗", recall:async()=>{ reads++; return {items:[]}; },
    plan:({signal}) => { signal.addEventListener("abort",()=>{aborted=true;}); return new Promise((resolve)=>{finish=resolve;}); } });
  assert.deepEqual(result,[]); assert.equal(aborted,true);
  finish("桌宠"); await Promise.resolve(); await Promise.resolve(); assert.equal(reads,1);
});
