import test from "node:test";
import assert from "node:assert/strict";
import { buildCurrentEvidenceWindow, isQuestionEvidenceUsable, videoQuestionEvidence } from "../src/ai/shared-experience-evidence-window.js";

test("video evidence discards browser loading and debug chrome while preserving game action", () => {
  const result = videoQuestionEvidence({id:"v",kind:"visual",text:"ChatGPT started debugging this browser. 网页正在加载，显示加载提示。角色拿着枪走进车厢。"});
  assert.equal(result.text,"角色拿着枪走进车厢。");
  assert.equal(videoQuestionEvidence({kind:"audio",text:"解说说这里正在加载下一关。"}).text,"解说说这里正在加载下一关。");
});

test("current narration groups adjoining fragments with source ids and excludes old scenes", () => {
  const result = buildCurrentEvidenceWindow([
    { id: "old", kind: "audio", atMs: 1, endedAtMs: 5000, text: "之前救醒了母亲。" },
    { id: "a", kind: "audio", atMs: 60000, endedAtMs: 65000, text: "普通武器无法伤到敌人，所以他们" },
    { id: "v", kind: "visual", atMs: 64000, text: "角色拿着一把弓" },
    { id: "b", kind: "audio", atMs: 65200, endedAtMs: 70000, text: "改用弓箭引开守卫，再从侧门进去。" },
  ], { focusEvidenceIds: ["b"] });
  assert.deepEqual(result.audio.map((event) => event.id), ["a", "b"]);
  assert.deepEqual(result.visual.map((event) => event.id), ["v"]);
  assert.match(result.text, /普通武器.*\n.*改用弓箭/s);
  assert.doesNotMatch(result.text, /救醒了母亲/);
  assert.equal(result.audio[1].gapBeforeMs, 200);
});

test("missing audio is marked as a gap and never silently joined", () => {
  const result = buildCurrentEvidenceWindow([
    { id: "a", kind: "audio", atMs: 1000, endedAtMs: 3500, text: "他准备打开箱子，但是" },
    { id: "b", kind: "audio", atMs: 9000, endedAtMs: 11500, text: "另一名玩家已经离开房间。" },
  ]);
  assert.equal(result.audio[1].gapBeforeMs, 5500);
  assert.match(result.text, /采集空档 5500ms/);
});

test("broken ASR remains raw evidence but cannot seed a question", () => {
  const result = buildCurrentEvidenceWindow([
    { id: "a", kind: "audio", atMs: 1, text: "鉱世が離 行きます！" },
    { id: "b", kind: "audio", atMs: 2, text: "但军方的武器无法杀死魔，所以主力部队" },
  ]);
  assert.equal(result.questionAudio.length, 0);
  assert.equal(result.audio.length, 2);
});

test("clear English game narration can seed a question without accepting short foreign noise", () => {
  const result = buildCurrentEvidenceWindow([
    { id: "en", kind: "audio", atMs: 1, text: "One day, the radiation on the surface might subside." },
    { id: "noise", kind: "audio", atMs: 2, text: "go go" },
  ]);
  assert.deepEqual(result.questionAudio.map((event) => event.id), ["en"]);
});

test("a dangling English preposition cannot become the premise of a question", () => {
  assert.equal(isQuestionEvidenceUsable({kind: "audio", text: "Get ready to go. Then we'll discuss your transfer to."}), false);
});
