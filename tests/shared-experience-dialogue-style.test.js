import test from "node:test";
import assert from "node:assert/strict";

import { findSharedExperienceAuditStyle } from "../src/ai/shared-experience-dialogue-style.js";
import { createSharedExperienceWorkspace } from "../src/ai/shared-experience-workspace.js";

test("dialogue style gate detects evidence-audit phrasing that breaks co-viewing immersion", () => {
  assert.deepEqual(findSharedExperienceAuditStyle("这句只交代了他进门，具体身份还没揭晓。"), [
    "sentence-audit",
    "scripted-unknown",
  ]);
  assert.deepEqual(findSharedExperienceAuditStyle("声音说他要离开，但画面和声音对不上。"), ["forced-av-comparison"]);
  assert.deepEqual(findSharedExperienceAuditStyle("别的剧情走向还得再等等看。"), ["scripted-wait"]);
  assert.deepEqual(findSharedExperienceAuditStyle("这个身份只能等后面揭晓。"), ["scripted-wait"]);
});

test("dialogue style gate accepts direct companion-like discussion", () => {
  assert.deepEqual(findSharedExperienceAuditStyle("他终于决定进门了，我觉得这一步挺冒险的。"), []);
  assert.deepEqual(findSharedExperienceAuditStyle("目前更像是在试探，后面怎么走还不好说。"), []);
});

test("co-viewing replies are prompted as relaxed conversation rather than mechanical answers", () => {
  const workspace = createSharedExperienceWorkspace({ windowId: 7, nowMs: () => 60_000 });
  const prompt = workspace.renderPrompt({ question: "刚才发生什么了？" });
  assert.match(prompt, /轻松自然/);
  assert.match(prompt, /接住用户/);
  assert.match(prompt, /不要像答题|不要用问答模板/);
});
