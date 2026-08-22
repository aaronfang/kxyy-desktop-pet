import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { classifySettingsUpdate } from "../src/ai/settings-update-policy.js";

const root = new URL("../", import.meta.url);
const settingsSource = fs.readFileSync(new URL("src/settings.js", root), "utf8");
const chatSource = fs.readFileSync(new URL("src/chat.js", root), "utf8");
const rustSource = fs.readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");

test("full settings snapshots preserve an active conversation when identity is unchanged", () => {
  assert.deepEqual(
    classifySettingsUpdate(
      { personaCardId: "", realtimeBackend: "voxcpm", userName: "ππ" },
      {
        personaCardId: "",
        realtimeBackend: "voxcpm",
        userName: "ππ",
        hidden: true,
        sizePercent: 175,
        monitorId: "display-2",
        topicPreferences: [{ topic: "电影影视", status: "interested" }],
      },
    ),
    {
      personaChanged: false,
      backendChanged: false,
      identityChanged: false,
    },
  );
});

test("only actual persona backend or identity changes cross their lifecycle boundaries", () => {
  const current = {
    personaCardId: "",
    realtimeBackend: "voxcpm",
    userName: "ππ",
    personaFacts: "旧事实",
  };

  assert.deepEqual(classifySettingsUpdate(current, { personaCardId: "elon-musk" }), {
    personaChanged: true,
    backendChanged: false,
    identityChanged: false,
  });
  assert.deepEqual(classifySettingsUpdate(current, { realtimeBackend: "local" }), {
    personaChanged: false,
    backendChanged: true,
    identityChanged: false,
  });
  assert.deepEqual(classifySettingsUpdate(current, { personaFacts: "新事实" }), {
    personaChanged: false,
    backendChanged: false,
    identityChanged: true,
  });
});

test("settings and inferred topic updates have one scoped event source", () => {
  const saveStart = settingsSource.indexOf("async function save() {");
  const saveEnd = settingsSource.indexOf("// ---- 头像上传", saveStart);
  const saveFunction = settingsSource.slice(saveStart, saveEnd);
  assert.doesNotMatch(saveFunction, /emit\("apply-settings"/);

  const mergeStart = rustSource.indexOf("fn merge_topic_preferences(");
  const mergeEnd = rustSource.indexOf("/// 前端用于按平台", mergeStart);
  const mergeFunction = rustSource.slice(mergeStart, mergeEnd);
  assert.doesNotMatch(mergeFunction, /commit_settings/);
  assert.match(mergeFunction, /topic-preferences-updated/);

  const listenerStart = chatSource.indexOf('listen("apply-settings"');
  const listenerEnd = chatSource.indexOf('// 设置页清空长期记忆', listenerStart);
  const applySettingsListener = chatSource.slice(listenerStart, listenerEnd);
  assert.match(applySettingsListener, /classifySettingsUpdate/);
  assert.doesNotMatch(applySettingsListener, /resetConversation\(/);
});
