import test from "node:test";
import assert from "node:assert/strict";

import { classifySharedExperienceContentMode, viewingStatementContentMode } from "../src/ai/shared-experience-content-mode.js";

test("content titles classify narrated videos conservatively", () => {
  assert.equal(classifySharedExperienceContentMode("韩漫《暗影君王》解说"), "narrated");
  assert.equal(classifySharedExperienceContentMode("十分钟看完电影剧情"), "narrated");
  assert.equal(classifySharedExperienceContentMode("电影正片"), "direct");
  assert.equal(classifySharedExperienceContentMode(""), "unknown");
});

test("a generic user declaration selects narration without requiring a work title", () => {
  assert.equal(viewingStatementContentMode("我们在看游戏解说视频"), "narrated");
  assert.equal(viewingStatementContentMode("我们一起看《星际穿越》电影"), "direct");
  assert.equal(viewingStatementContentMode("我觉得这个解说很有趣"), null);
  assert.equal(viewingStatementContentMode("这个窗口标题叫解说"), null);
});
