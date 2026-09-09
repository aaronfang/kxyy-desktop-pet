import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("src/settings.html", root), "utf8");
const settingsJs = fs.readFileSync(new URL("src/settings.js", root), "utf8");
const chatJs = fs.readFileSync(new URL("src/chat.js", root), "utf8");

test("settings expose an opt-in co-viewing initiative switch and fixed frequency choices", () => {
  assert.match(html, /id="sharedExperienceProactiveEnabled"[^>]*type="checkbox"/);
  assert.match(html, /id="sharedExperienceProactiveFrequency"/);
  for (const value of ["low", "standard", "frequent"]) {
    assert.match(html, new RegExp(`<option value="${value}"`));
  }
  assert.match(settingsJs, /sharedExperienceProactiveEnabled:\s*el\("sharedExperienceProactiveEnabled"\)\.checked/);
  assert.match(settingsJs, /sharedExperienceProactiveFrequency:\s*el\("sharedExperienceProactiveFrequency"\)\.value/);
});

test("chat applies initiative settings at session start and when settings change", () => {
  assert.match(chatJs, /resolveSharedExperienceProactiveConfig/);
  assert.match(chatJs, /syncSharedExperienceProactive/);
  assert.match(chatJs, /listen\("apply-settings"[\s\S]*syncSharedExperienceProactive/);
  assert.match(chatJs, /function syncSharedExperienceProactive[\s\S]*cancelSharedExperienceProactive\("settings-changed",\s*\{ stopAudio: true \}\)/);
});
