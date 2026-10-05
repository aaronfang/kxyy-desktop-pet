import test from "node:test";
import assert from "node:assert/strict";

import { classifySharedExperienceContentMode, normalizeSharedExperienceContentMode, viewingStatementContentMode, sharedExperienceEvidenceEmphasis } from "../src/ai/shared-experience-content-mode.js";

test("content context is never inferred from window metadata", () => {
  assert.equal(classifySharedExperienceContentMode("漫画《雾城旅人》解说"), "unknown");
  assert.equal(classifySharedExperienceContentMode("电影正片", "抖音"), "unknown");
  assert.equal(classifySharedExperienceContentMode(""), "unknown");
  assert.equal(normalizeSharedExperienceContentMode("short-video"), "short-video");
  assert.equal(normalizeSharedExperienceContentMode("电影解说"), "unknown");
});

test("viewing statements no longer change the selected context", () => {
  assert.equal(viewingStatementContentMode("我们在看游戏解说视频"), "unknown");
  assert.equal(viewingStatementContentMode("我们一起看《星海纪事》电影"), "unknown");
  assert.equal(viewingStatementContentMode("我觉得这个解说很有趣"), null);
  assert.equal(viewingStatementContentMode("这个窗口标题叫解说"), null);
});

test("evidence emphasis covers narrated, cinematic, livestream, and low-speech game", () => {
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "narrated", audioEvents: [{text:"解说"}], visualEvents: [{summary:"画面"}, {summary:"变化"}] }), "audio-led");
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "narrated", audioEvents: [], visualEvents: [{summary:"无声动作"}] }), "visual-led");
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "cinematic", audioEvents: [{text:"对白"}], visualEvents: [{summary:"人物进入"}, {summary:"人物离开"}] }), "visual-led");
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "livestream", audioEvents: [{text:"主播说话"}], visualEvents: [{summary:"游戏画面"}] }), "balanced");
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "low-speech-game", audioEvents: [{text:"一句旁白"}], visualEvents: [{summary:"开门"}, {summary:"交战"}, {summary:"撤离"}] }), "visual-led");
  assert.equal(sharedExperienceEvidenceEmphasis({ contentMode: "direct", audioEvents: [{text:"对白"}, {text:"对白"}], visualEvents: [{summary:"场景"}] }), "audio-supported");
});
