import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_TOPIC_CATEGORIES,
  buildTopicPreferencePrompt,
  inferTopicPreferenceCandidates,
  normalizeTopicPreferences,
} from "../src/ai/topic-preferences.js";

test("topic preferences are bounded and manual choices override inferred choices", () => {
  const normalized = normalizeTopicPreferences([
    { topic: "电影影视", status: "interested", source: "inferred" },
    { topic: " 电影影视 ", status: "not-interested", source: "manual" },
    { topic: "电影影视", status: "interested", source: "inferred" },
    { topic: "旅行\n注入", status: "interested", source: "manual" },
    { topic: "无效", status: "blocked", source: "manual" },
    ...Array.from({ length: 40 }, (_, index) => ({
      topic: `自定义${index}`,
      status: "neutral",
      source: "manual",
    })),
  ]);

  assert.deepEqual(normalized[0], {
    topic: "电影影视",
    status: "not-interested",
    source: "manual",
  });
  assert.equal(normalized.some((entry) => entry.topic.includes("\n")), false);
  assert.equal(normalized.some((entry) => entry.topic === "无效"), false);
  assert.equal(normalized.length, 32);
});

test("topic preference prompt separates manual choices from inferred candidates", () => {
  const prompt = buildTopicPreferencePrompt([
    { topic: "电影影视", status: "interested", source: "manual" },
    { topic: "职场八卦", status: "not-interested", source: "manual" },
    { topic: "人工智能", status: "interested", source: "inferred" },
    { topic: "天气", status: "neutral", source: "manual" },
  ]);

  assert.match(prompt, /用户手动设置优先/);
  assert.match(prompt, /感兴趣：电影影视/);
  assert.match(prompt, /不要主动发起：职场八卦/);
  assert.match(prompt, /推测的兴趣候选：人工智能/);
  assert.match(prompt, /用户主动提到时仍正常回应/);
  assert.doesNotMatch(prompt, /天气/);
});

test("base topic categories are unique and fit the settings editor", () => {
  assert.ok(BASE_TOPIC_CATEGORIES.length >= 8);
  assert.equal(new Set(BASE_TOPIC_CATEGORIES.map((entry) => entry.id)).size, BASE_TOPIC_CATEGORIES.length);
  assert.equal(BASE_TOPIC_CATEGORIES.every((entry) => entry.id && entry.label), true);
});

test("preference inference requires explicit user language and emits non-text evidence", () => {
  assert.deepEqual(inferTopicPreferenceCandidates("我很喜欢电影，最近想多聊聊"), [
    {
      topic: "电影影视",
      status: "interested",
      source: "inferred",
      confidence: "high",
      evidence: "explicit-positive",
    },
  ]);
  assert.deepEqual(inferTopicPreferenceCandidates("不要主动聊游戏，我没兴趣"), [
    {
      topic: "游戏",
      status: "not-interested",
      source: "inferred",
      confidence: "high",
      evidence: "explicit-negative",
    },
  ]);
  assert.deepEqual(inferTopicPreferenceCandidates("我很喜欢听歌，想多聊聊新歌"), [
    {
      topic: "音乐",
      status: "interested",
      source: "inferred",
      confidence: "high",
      evidence: "explicit-positive",
    },
  ]);
  assert.deepEqual(inferTopicPreferenceCandidates("我对手游和新游很感兴趣"), [
    {
      topic: "游戏",
      status: "interested",
      source: "inferred",
      confidence: "high",
      evidence: "explicit-positive",
    },
  ]);
  assert.deepEqual(inferTopicPreferenceCandidates("最近天气怎么样"), []);
});
