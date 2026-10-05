import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { resolveSharedExperienceProactiveConfig } from "../src/ai/shared-experience-proactive.js";

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
  assert.match(html, /设定两次主动发言之间的最短间隔/);
  assert.match(html, /高频至少间隔 30 秒/);
});

test("chat applies initiative settings at session start and when settings change", () => {
  assert.match(chatJs, /resolveSharedExperienceProactiveConfig/);
  assert.match(chatJs, /syncSharedExperienceProactive/);
  assert.match(chatJs, /listen\("apply-settings"[\s\S]*syncSharedExperienceProactive/);
  assert.match(chatJs, /function syncSharedExperienceProactive[\s\S]*cancelSharedExperienceProactive\("settings-changed",\s*\{ stopAudio: true \}\)/);
});

test("passive mode stays silent and toggling initiative on or off changes the active session", () => {
  const start = chatJs.indexOf("function syncSharedExperienceProactive(");
  const end = chatJs.indexOf("async function generateSharedExperienceProactive(", start);
  assert.ok(start >= 0 && end > start);
  const created = [];
  const sharedExperience = { active: true, proactiveRunner: null };
  const settings = { sharedExperienceProactiveEnabled: false, sharedExperienceProactiveFrequency: "frequent" };
  const timers = new Set();
  const context = {
    sharedExperience, settings, resolveSharedExperienceProactiveConfig,
    window: {
      setInterval: (_callback, interval) => { assert.equal(interval, 1_000); const id = timers.size + 1; timers.add(id); return id; },
      clearInterval: (id) => timers.delete(id),
    },
    maybeTriggerSharedExperienceProactive: () => {},
    cancelSharedExperienceProactive: () => Promise.resolve(),
    createSharedExperienceProactiveDirector: (config) => { created.push(config); return {}; },
    createSharedExperienceProactiveRunner: () => ({ consider: async () => ({ started: true }) }),
    generateSharedExperienceProactive: async () => ({}),
    Date,
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  context.syncSharedExperienceProactive();
  assert.equal(sharedExperience.proactiveRunner, null);
  settings.sharedExperienceProactiveEnabled = true;
  context.syncSharedExperienceProactive();
  assert.equal(typeof sharedExperience.proactiveRunner.consider, "function");
  assert.equal(created[0].firstDelayMs, 20_000);
  assert.equal(created[0].minIntervalMs, 20_000);
  assert.equal(timers.size, 1);
  settings.sharedExperienceProactiveEnabled = false;
  context.syncSharedExperienceProactive();
  assert.equal(sharedExperience.proactiveRunner, null);
  assert.equal(timers.size, 0);
});
