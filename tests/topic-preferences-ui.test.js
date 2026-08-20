import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const settingsHtml = fs.readFileSync(new URL("src/settings.html", root), "utf8");
const settingsJs = fs.readFileSync(new URL("src/settings.js", root), "utf8");
const chatJs = fs.readFileSync(new URL("src/chat.js", root), "utf8");

test("settings exposes editable base and custom topic preferences", () => {
  assert.match(settingsHtml, /id="topicPreferenceRows"/);
  assert.match(settingsHtml, /id="topicPreferenceCustom"/);
  assert.match(settingsHtml, /id="topicPreferenceCustomStatus"/);
  assert.match(settingsJs, /normalizeTopicPreferences/);
  assert.match(settingsJs, /topicPreferences: collectTopicPreferences\(\)/);
  assert.match(settingsJs, /topicPreferenceAdd/);
  assert.match(settingsHtml, /id="freshTopicSources"/);
  assert.match(settingsJs, /候选池 \$\{source\.candidateCount \|\| 0\} 条 · 入选/);
  assert.match(settingsHtml, /id="refreshFreshTopicStatus"/);
  assert.match(settingsHtml, /id="refreshFreshTopics"/);
  assert.match(settingsJs, /get_fresh_topic_status/);
  assert.match(settingsJs, /prefetch_fresh_topics/);
  assert.match(settingsJs, /open_external_url/);
  assert.match(settingsJs, /event\.preventDefault\(\)/);
  assert.match(settingsJs, /topicPreferences: collectTopicPreferences\(\)/);
  assert.match(settingsHtml, /中立 10 条、感兴趣 15 条、不主动聊 0 条/);
});

test("saving settings does not wait for a forced fresh-topic refresh", () => {
  const saveStart = settingsJs.indexOf("async function save() {");
  const saveEnd = settingsJs.indexOf("// ---- 头像上传", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, "save function should be present");
  const saveFunction = settingsJs.slice(saveStart, saveEnd);
  assert.doesNotMatch(saveFunction, /prefetch_fresh_topics/);
  assert.match(settingsJs, /reason: "manual",\s*force: true/);
});

test("realtime experimental role consumes structured preferences without adding chat text", () => {
  assert.match(chatJs, /buildTopicPreferencePrompt/);
  assert.match(chatJs, /settings\.realtimeConversationMode === "ai-leads"/);
  assert.match(chatJs, /settings\.topicPreferences/);
});

test("text chat keeps a session cooldown for fresh topic sources", () => {
  assert.match(chatJs, /const textFreshTopicIds = new Set\(\)/);
  assert.match(chatJs, /excludedSourceIds: \[\.\.\.textFreshTopicIds\]/);
  assert.match(chatJs, /takeFreshTopicsForSession\(topicsForPrompt, textFreshTopicIds\)/);
  assert.match(chatJs, /textFreshTopicIds\.clear\(\)/);
});
