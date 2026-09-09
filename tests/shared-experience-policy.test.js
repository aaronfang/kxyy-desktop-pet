import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  sharedExperienceReplyMaxTokens,
  sharedExperienceRequestPolicy,
  sharedExperienceTtsLatencyMode,
  sharedExperienceCaptureDelay,
} from "../src/ai/shared-experience-policy.js";

test("audio capture resumes without an intentional recording gap but failures back off", () => {
  assert.equal(sharedExperienceCaptureDelay({ kind: "audio", failed: false }), 0);
  assert.equal(sharedExperienceCaptureDelay({ kind: "audio", failed: true }), 3000);
  assert.equal(sharedExperienceCaptureDelay({ kind: "visual", failed: false }), 3000);
});

test("shared experience keeps persona conversation but isolates unrelated context sources", () => {
  assert.deepEqual(sharedExperienceRequestPolicy(true), {
    memoryRecall: false,
    freshTopics: false,
    webObservations: false,
    fewShot: false,
    sessionRecap: false,
    automaticFollowup: false,
    idleProactive: false,
  });
  assert.deepEqual(sharedExperienceRequestPolicy(false), {
    memoryRecall: true,
    freshTopics: true,
    webObservations: true,
    fewShot: true,
    sessionRecap: true,
    automaticFollowup: true,
    idleProactive: true,
  });
});

test("shared experience bounds spoken replies while normal chat keeps its token budget", () => {
  assert.equal(sharedExperienceReplyMaxTokens(true, 4096), 320);
  assert.equal(sharedExperienceReplyMaxTokens(true, 120), 120);
  assert.equal(sharedExperienceReplyMaxTokens(true, 800, { deliberate: true }), 1400);
  assert.equal(sharedExperienceReplyMaxTokens(false, 4096), 4096);
  assert.equal(sharedExperienceReplyMaxTokens(false, 800, { deliberate: true }), 800);
});

test("only shared-experience text speech requests the companion latency mode", () => {
  assert.equal(sharedExperienceTtsLatencyMode(true), "companion");
  assert.equal(sharedExperienceTtsLatencyMode(false), "default");
});

test("chat request, idle sharing, and follow-up paths consume the shared-experience policy", () => {
  const chat = fs.readFileSync(new URL("../src/chat.js", import.meta.url), "utf8");
  assert.match(chat, /const requestPolicy = sharedExperienceRequestPolicy\(sharedExperience\.active\)/);
  assert.match(chat, /requestPolicy\.memoryRecall[\s\S]*invoke\("memory_recall"/);
  assert.match(chat, /requestPolicy\.freshTopics[\s\S]*fetchFreshTopics/);
  assert.match(chat, /requestPolicy\.webObservations[\s\S]*fetchWebObservations/);
  assert.match(chat, /fewShot: requestPolicy\.fewShot \? fewShot : \[\]/);
  assert.match(chat, /earlierRecap: requestPolicy\.sessionRecap \? sessionRecap : ""/);
  assert.match(chat, /if \(!sharedExperienceRequestPolicy\(sharedExperience\.active\)\.idleProactive\) return/);
  assert.match(chat, /requestPolicy\.automaticFollowup && shouldDoFollowup/);
  assert.match(chat, /sharedExperienceReplyMaxTokens\(\s*sharedExperience\.active,[\s\S]*\{\s*deliberate\s*\}/);
  assert.match(chat, /if \(!review\) \{[\s\S]*requestGroundedReplyRepair\(/);
  assert.match(chat, /requestGroundedReplyRepair\(\{[\s\S]*evidence:reviewSources,[\s\S]*isCurrent:groundingIsCurrent/);
  assert.match(chat, /latencyMode:\s*sharedExperienceTtsLatencyMode\(sharedExperience\.active\)/);
  assert.match(chat, /withSharedExperienceInferencePaused\(\{[\s\S]*enabled:\s*Boolean\(inferenceSpool\),[\s\S]*reason:\s*"tts"/);
  assert.match(chat, /if \(sharedExperience\.active\) memoryEnqueuedIds\.add\(userId\)/);
  assert.match(chat, /if \(sharedExperience\.active\) memoryEnqueuedIds\.add\(replyId\)/);
  assert.match(chat, /invoke\("memory_record_shared_experience"[\s\S]*sessionId: episode\.sessionId,[\s\S]*summary: episode\.summary,[\s\S]*occurredAt:/);
});
