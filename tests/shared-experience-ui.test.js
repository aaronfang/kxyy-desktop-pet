import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { sharedExperienceProactiveGroundingPrompt } from "../src/ai/shared-experience-proactive.js";

const root = new URL("../", import.meta.url);
const chatCss = fs.readFileSync(new URL("src/chat.css", root), "utf8");
const chatHtml = fs.readFileSync(new URL("src/chat.html", root), "utf8");
const tauriConfig = JSON.parse(fs.readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const chatJs = fs.readFileSync(new URL("src/chat.js", root), "utf8");

test("chat summary adapter forwards media mode for every summary level", async () => {
  const start = chatJs.indexOf("async function summarizeSharedExperience(");
  const end = chatJs.indexOf("async function persistSharedExperienceEpisode(", start);
  for (const contentMode of ["narrated", "cinematic", "livestream", "low-speech-game"]) {
    for (const kind of ["evidence", "segment", "final"]) {
      let received;
      const context = {
        apiBase: "http://127.0.0.1:1234", sharedExperience: { lifecycle: {} },
        settings: {}, fetchDeepSeekBalance: () => {},
        requestSharedExperienceSummary: async (args) => { received = args; return { summary: "总结" }; },
      };
      vm.runInNewContext(chatJs.slice(start, end), context);
      await context.summarizeSharedExperience({ kind, contentMode, source: "资料", evidence: [] });
      assert.equal(received.contentMode, contentMode);
      assert.equal(received.kind, kind);
    }
  }
});

test("co-viewing exposes an explicit manual context selector", () => {
  assert.match(chatHtml, /id="shared-experience-mode"/);
  for (const mode of ["cinematic", "narrated", "game-narrated", "livestream", "short-video", "low-speech-game", "direct"]) {
    assert.match(chatHtml, new RegExp(`option value="${mode}"`));
  }
  assert.match(chatJs, /setSharedExperienceContentMode\(sharedExperienceMode\.value\)/);
  assert.match(chatJs, /contentMode: "unknown"/);
});

test("co-viewing exposes a live frequency selector beside the context selector", () => {
  assert.match(chatHtml, /id="shared-experience-frequency"/);
  for (const value of ["low", "standard", "frequent"]) assert.match(chatHtml, new RegExp(`option value="${value}"`));
  assert.match(chatJs, /sharedExperienceFrequency\?\.addEventListener\("change"/);
  assert.match(chatJs, /配置频率/);
});

test("native null proactive timing fields preserve frequency defaults", () => {
  const start = chatJs.indexOf("  syncSharedExperienceProactive({", chatJs.indexOf("async function connectSharedExperience("));
  const end = chatJs.indexOf("\n  });", start) + 6;
  assert.ok(start >= 0 && end > start);
  for (const value of [null, undefined, "", false, 30000]) {
    let received;
    vm.runInNewContext(chatJs.slice(start, end), {
      proactiveEnabled: true, proactiveFirstDelayMs: value, proactiveMinIntervalMs: value,
      syncSharedExperienceProactive: (config) => { received = JSON.parse(JSON.stringify(config)); },
    });
    assert.deepEqual(received, typeof value === "number"
      ? { enabled: true, firstDelayMs: value, minIntervalMs: value } : { enabled: true });
  }
});

test("failed unsolicited comment leaves no error bubble or hidden user turn", async () => {
  const start = chatJs.indexOf("async function generateSharedExperienceProactive(");
  const end = chatJs.indexOf("function maybeTriggerSharedExperienceProactive()", start);
  assert.ok(start >= 0 && end > start);
  const history = [];
  const row = { removed: false, classList: { add() {} }, remove() { this.removed = true; } };
  const context = {
    sharedExperience: { active: true, paused: false, generation: 1 },
    history,
    memoryEnqueuedIds: new Set(),
    getProactiveUserTrigger: () => "hidden trigger",
    genMsgId: (() => { let id = 0; return () => `message-${++id}`; })(),
    addBubble: () => ({ closest: () => row }),
    petSignal() {}, setBusy() {}, scrollBottom() {},
    sharedExperienceProactiveGroundingPrompt,
    streamAssistantReply: async () => { throw new Error("provider unavailable"); },
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  await assert.rejects(context.generateSharedExperienceProactive({
    reason: "speech-event", evidenceIds: ["ev-1"], signal: new AbortController().signal,
  }), /provider unavailable/);
  assert.equal(row.removed, true);
  assert.equal(history.length, 0);
});

test("proactive comments keep the placeholder hidden until a usable reply is ready", () => {
  const start = chatJs.indexOf("async function generateSharedExperienceProactive(");
  const end = chatJs.indexOf("function maybeTriggerSharedExperienceProactive()", start);
  assert.match(chatJs.slice(start, end), /proactive-pending/);
  assert.match(chatCss, /\.row\.proactive-pending\s*\{\s*display:\s*none/);
  assert.match(chatJs, /firstRow\?\.classList\.remove\("proactive-pending"\)/);
});

test("hiding or showing chat preserves active co-viewing, speech and manual pause", () => {
  const start = chatJs.indexOf("async function prepareAndFlushMemory(");
  const end = chatJs.indexOf('listen("flush-memory-before-quit"', start);
  assert.ok(start >= 0 && end > start);
  for (const paused of [false, true]) {
    const calls = [];
    const document = { visibilityState: "hidden", addEventListener: (_, callback) => { document.change = callback; } };
    const context = {
      document, callActive: false, sharedExperience: { active: true, paused },
      stopSpeak: () => calls.push("stop-speech"), resetTtsQueue: () => calls.push("reset-speech"),
      setCompanionAudioActive: (active) => calls.push(`companion-audio-${active}`),
      enqueueMemory: async () => calls.push("memory"),
      pauseSharedExperience: () => calls.push("pause"), resumeSharedExperience: () => calls.push("resume"),
    };
    vm.runInNewContext(chatJs.slice(start, end), context);
    document.change();
    document.visibilityState = "visible";
    document.change();
    assert.deepEqual(calls, ["companion-audio-true", "companion-audio-true"]);
    assert.equal(context.sharedExperience.paused, paused);
  }
});

test("entering hidden state reasserts the companion audio keep-alive", () => {
  const start = chatJs.indexOf("async function prepareAndFlushMemory(");
  const end = chatJs.indexOf('listen("flush-memory-before-quit"', start);
  const calls = [];
  const document = { visibilityState: "hidden", addEventListener: (_, callback) => { document.change = callback; } };
  const context = {
    document, callActive: false, sharedExperience: { active: true },
    stopSpeak: () => calls.push("stop-speech"), resetTtsQueue: () => calls.push("reset-speech"),
    setCompanionAudioActive: (active) => calls.push(`companion-audio-${active}`),
    enqueueMemory: async () => calls.push("memory"),
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  document.change();
  assert.deepEqual(calls, ["companion-audio-true"]);
});

test("ordinary chat still flushes on hide and app quit still stops speech", async () => {
  const start = chatJs.indexOf("async function prepareAndFlushMemory(");
  const end = chatJs.indexOf('listen("flush-memory-before-quit"', start);
  const calls = [];
  const document = { visibilityState: "hidden", addEventListener: (_, callback) => { document.change = callback; } };
  const context = {
    document, callActive: false, sharedExperience: { active: false },
    stopSpeak: () => calls.push("stop"), resetTtsQueue: () => calls.push("reset"),
    setCompanionAudioActive: () => {},
    enqueueMemory: async () => calls.push("memory"),
    pauseSharedExperience: () => {}, resumeSharedExperience: () => {},
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  document.change();
  assert.deepEqual(calls, ["stop", "reset", "memory"]);
  calls.length = 0;
  context.sharedExperience.active = true;
  await vm.runInNewContext("prepareAndFlushMemory()", context);
  assert.deepEqual(calls, ["stop", "reset", "memory"]);
});

test("shared-experience overlays stay fixed when they are direct chat children", () => {
  for (const id of ["shared-experience-picker", "shared-experience-debug"]) {
    const selector = new RegExp(
      `#chat\\s*>\\s*#${id}\\s*\\{[^}]*position:\\s*fixed;[^}]*inset:\\s*0;`,
      "s",
    );
    assert.match(chatCss, selector, `${id} must override the generic #chat > * positioning rule`);
    assert.match(
      chatCss,
      new RegExp(`#chat\\s*>\\s*#${id}\\[hidden\\]\\s*\\{[^}]*display:\\s*none;`, "s"),
      `${id} must remain hidden when its direct-child selector becomes more specific`,
    );
  }
});

test("restoring composer focus after a reply does not cancel companion speech", () => {
  const busyStart = chatJs.indexOf("function setBusy(");
  const busyEnd = chatJs.indexOf("// ---- 待发送图片", busyStart);
  const focusStart = chatJs.indexOf('inputEl.addEventListener("focus"');
  const focusEnd = chatJs.indexOf('inputEl.addEventListener("input"', focusStart);
  assert.ok(busyStart >= 0 && busyEnd > busyStart && focusStart >= 0 && focusEnd > focusStart);
  const cancellations = [];
  const inputEl = {
    disabled: false,
    addEventListener(name, handler) { if (name === "focus") this.onFocus = handler; },
    focus() { this.onFocus?.(); },
  };
  const context = {
    inputEl,
    sendBtn: {}, attachBtn: {}, stickersBtn: {},
    sharedExperience: { active: true, proactivePromise: Promise.resolve() },
    cancelSharedExperienceProactive: (reason) => cancellations.push(reason),
    Date,
  };
  vm.runInNewContext(`${chatJs.slice(busyStart, busyEnd)}\n${chatJs.slice(focusStart, focusEnd)}`, context);
  vm.runInNewContext("setBusy(false)", context);
  assert.deepEqual(cancellations, []);
  inputEl.focus();
  assert.deepEqual(cancellations, ["user-active"]);
});

test("debug acceptance can hide and restore chat without stopping co-viewing", async () => {
  const start = chatJs.indexOf("const actions = Array.isArray(payload?.actions)");
  const end = chatJs.indexOf("const viewingStatement =", start);
  assert.ok(start >= 0 && end > start);
  const commands = [];
  const sharedExperience = { active: true, paused: false };
  const context = {
    payload: { actions: [{ name: "hide-chat" }, { name: "show-chat" }] },
    window: { setTimeout: (callback) => callback() },
    invoke: async (command) => { commands.push(command); },
    sharedExperience,
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, ["hide_chat", "toggle_chat_window"]);
  assert.equal(sharedExperience.active, true);
  assert.equal(sharedExperience.paused, false);
});

test("stopping co-viewing clears the avatar mood animation immediately", () => {
  const start = chatJs.indexOf("function stopSharedExperienceCapture()");
  const end = chatJs.indexOf("function scheduleSharedExperienceRollover()", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const sharedExperience = {
    active: true, generation: 1, paused: false, observing: true, transcribing: true,
    capturing: true, capturingAudio: true, proactiveTimer: 0, timer: 0, captureTimer: 0, audioTimer: 0,
  };
  const context = {
    sharedExperience, cancelSharedExperienceProactive() {}, activeVisualContext: {},
    invoke: async () => {}, sharedExperienceBtn: null, sharedExperiencePauseBtn: null,
    sharedExperienceStopBtn: null, clearMoodVisual: () => calls.push("clear-mood"),
  };
  vm.runInNewContext(chatJs.slice(start, end), context);
  context.stopSharedExperienceCapture();
  assert.deepEqual(calls, ["clear-mood"]);
});

test("co-viewing debug renders proactive mode, turn counts, and next-turn countdown", () => {
  assert.match(chatJs, /frequent:\s*"高频"/);
  assert.match(chatJs, /完成\$\{proactive\.completed\}\/失败\$\{proactive\.failed\}\/取消\$\{proactive\.cancelled\}/);
  assert.match(chatJs, /下次最早/);
  assert.match(chatJs, /sharedExperienceProactiveDiagnostics/);
});

test("co-viewing promotes only bounded adaptive frame windows into Mage-VL", () => {
  assert.match(chatJs, /normalizeSharedExperienceVisualCapture\(capture\)/);
  assert.match(chatJs, /invoke\("observe_shared_experience_frames",\s*\{ frames: next\.payload\.frames \}\)/);
  assert.doesNotMatch(chatJs, /invoke\("observe_shared_experience_frame",\s*\{ imageDataUrl: next\.payload \}\)/);
  assert.match(chatJs, /sharedExperienceCaptureDelay\(\{ kind: "visual", failed \}\)/);
  assert.doesNotMatch(chatJs, /setTimeout\(captureSharedExperienceOnce,\s*3000\)/);
  assert.match(chatJs, /visualWindowQueued/);
});

test("co-viewing pause stops native sampling and debug exposes bounded visual telemetry", () => {
  assert.match(chatJs, /pauseSharedExperience[\s\S]*invoke\("stop_shared_experience_frame_stream"\)/);
  assert.match(chatJs, /原始\$\{visual\.sampledFrames\}\/窗口\$\{visual\.emittedWindows\}\/合并\$\{visual\.coalescedFrames\}\/丢弃\$\{visual\.droppedFrames\}/);
  assert.match(chatJs, /latestChangeScorePpm/);
  assert.match(chatJs, /nextWindowInMs/);
});

test("the packaged app includes the native adaptive frame helper", () => {
  assert.equal(
    tauriConfig.bundle.resources["../scripts/mage-vl/capture_frames.swift"],
    "scripts/mage-vl/capture_frames.swift",
  );
});
