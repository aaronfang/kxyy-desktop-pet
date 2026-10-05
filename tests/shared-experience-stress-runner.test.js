import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { buildStressPlan } from "../scripts/shared-experience/stress-plan-30min.mjs";
import {
  assertExternalReportPath,
  buildDevStressEnvironment,
  runSharedExperienceStressWithAdapters,
  runSharedExperienceStressSimulation,
  validateRealStressReport,
  installStressSignalHandlers,
  terminateOwnedProcess,
} from "../scripts/shared-experience/run-30min.mjs";
import { EventEmitter } from "node:events";
import { createStressReportReceiver } from "../scripts/shared-experience/stress-report-server.mjs";

test("report receiver fails promptly on write failure and preserves existing data", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kxyy-receiver-"));
  const output = path.join(directory, "report.json");
  const receiver = createStressReportReceiver({ outputPath: output, inspectIsolation: () => [], supported: true });
  try {
    const url = await receiver.listen(0);
    const first = await fetch(url, { method: "POST", body: JSON.stringify({ marker: "first" }) });
    assert.equal(first.status, 201);
    assert.equal(await receiver.closed, 0);
    const failing = createStressReportReceiver({ outputPath: output, inspectIsolation: () => [], supported: true });
    try {
      const secondUrl = await failing.listen(0);
      const response = await fetch(secondUrl, { method: "POST", body: JSON.stringify({ marker: "second" }) });
      assert.equal(response.status, 400);
      assert.equal(await failing.closed, 1);
      assert.equal(JSON.parse(readFileSync(output, "utf8")).marker, "first");
    } finally { await failing.close(); }
  } finally {
    await receiver.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed-app conflict aborts receiver without signaling the app or storing a report", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kxyy-receiver-conflict-"));
  const output = path.join(directory, "report.json");
  const receiver = createStressReportReceiver({ outputPath: output, supported: true,
    inspectIsolation: () => [{ pid: 4242, executable: "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet" }],
  });
  try {
    await assert.rejects(receiver.listen(0), /installed app/);
    assert.equal(await receiver.closed, 1);
    assert.throws(() => readFileSync(output), { code: "ENOENT" });
  } finally {
    await receiver.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed and oversized reports stop the receiver without writing an artifact", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kxyy-receiver-invalid-"));
  try {
    for (const body of ["not JSON", "x".repeat(5 * 1024 * 1024 + 1)]) {
      const output = path.join(directory, "report.json");
      const receiver = createStressReportReceiver({ outputPath: output, supported: false,
        inspectIsolation: () => { throw new Error("unsupported check must not run"); } });
      try {
        const url = await receiver.listen(0);
        if (body === "not JSON") {
          const response = await fetch(url, { method: "POST", body });
          assert.equal(response.status, 400);
        } else {
          await assert.rejects(fetch(url, { method: "POST", body }));
        }
        assert.equal(await receiver.closed, 1);
        assert.throws(() => readFileSync(output), { code: "ENOENT" });
      } finally { await receiver.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("stress interruption cancels once and removes its signal handlers", () => {
  const signals = new EventEmitter();
  const received = [];
  const dispose = installStressSignalHandlers((signal) => received.push(signal), signals);
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  assert.deepEqual(received, ["SIGINT"]);
  dispose();
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("owned process cleanup kills detached descendants even after their leader exits", { skip: process.platform === "win32", timeout: 8000 }, async () => {
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    child.unref();
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const descendantPid = await new Promise((resolve, reject) => {
    leader.stdout.once("data", (data) => resolve(Number(String(data).trim())));
    leader.once("error", reject);
  });
  await new Promise((resolve) => leader.once("exit", resolve));
  try {
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    await terminateOwnedProcess(leader);
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(descendantPid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false);
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
  }
});

test("stress runner simulation completes the full 30-minute 90-slot plan without real services", async () => {
  let now = 0;
  const report = await runSharedExperienceStressSimulation({
    plan: buildStressPlan(),
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
  });

  assert.equal(report.plannedDurationMs, 30 * 60 * 1000);
  assert.equal(report.plannedTurns, 90);
  assert.equal(report.completedTurns, 90);
  assert.equal(report.successfulTurns, 90);
  assert.equal(report.failedTurns, 0);
  assert.equal(report.skippedTurns, 0);
  assert.equal(report.environment.buildKind, "dev-simulation");
  assert.equal(report.environment.realServices, false);
  assert.equal(report.finalize.cleanup.complete, true);
});

test("real stress runner builds the existing debug hook environment without credentials", () => {
  const environment = buildDevStressEnvironment({
    windowId: 42,
    reportUrl: "http://127.0.0.1:17861/report",
    userStatement: "我们在看一段游戏解说",
    plan: { durationMs: 100, turns: [{ atMs: 10, dynamic: true }] },
  });

  assert.equal(environment.KXYY_SHOW_CHAT_ON_START, "1");
  assert.equal(environment.KXYY_START_SHARED_EXPERIENCE_WINDOW_ID, "42");
  assert.equal(environment.KXYY_SHARED_EXPERIENCE_REPORT_URL, "http://127.0.0.1:17861/report");
  assert.equal(environment.KXYY_SHARED_EXPERIENCE_USER_STATEMENT, "我们在看一段游戏解说");
  assert.deepEqual(JSON.parse(environment.KXYY_SHARED_EXPERIENCE_TEST_PLAN_JSON), {
    durationMs: 100,
    turns: [{ atMs: 10, dynamic: true }],
  });
  assert.equal(Object.keys(environment).some((key) => /key|secret|token/i.test(key)), false);
});

test("proactive-only acceptance does not inject questions or a synthetic user opening", () => {
  const environment = buildDevStressEnvironment({
    windowId: 42,
    reportUrl: "http://127.0.0.1:17861/report",
    userStatement: "我们在看一段游戏解说",
    proactiveOnly: true,
  });
  assert.deepEqual(JSON.parse(environment.KXYY_SHARED_EXPERIENCE_TEST_PLAN_JSON), {
    durationMs: 30 * 60 * 1000,
    turns: [],
  });
  assert.equal(environment.KXYY_SHARED_EXPERIENCE_USER_STATEMENT, undefined);
});

test("proactive-only report accepts no user turns only when grounded speech completed", () => {
  const startedAtMs = 1_000_000;
  const captureTimeline = {
    visual: Array.from({ length: 600 }, (_, index) => startedAtMs + index * 3_000 + 5_000),
    audio: Array.from({ length: 180 }, (_, index) => startedAtMs + index * 10_000 + 9_000),
  };
  const report = {
    startedAtMs,
    durationMs: 1_800_000,
    environment: { buildKind: "debug", realServices: true, visionProvider: "mage-vl", asrProvider: "sensevoice", textProvider: "deepseek", voiceBackend: "voxcpm", testMode: "proactive-only" },
    isolation: { supported: true, checks: 1, violations: [] },
    plannedTurns: 0, successfulTurns: 0, failedTurns: 0, turns: [],
    beforeFinalize: {
      proactive: { totals: { completed: 2, ttsFailed: 0, ttsPartial: 0, ttsIncomplete: 0 }, events: [{ status: "completed", tts: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 } } }] },
      voiceService: { backend: "voxcpm", runningSeen: true, failures: 0 },
      runtimeReceipts: Object.fromEntries([["vision", "mage-vl"], ["asr", "sensevoice"], ["text", "deepseek"]].map(([kind, provider]) => [kind, { provider, successfulResponses: 1, completedResponses: 1, failedResponses: 0 }])),
      workspace: { windowId: 42, capturedVisual: 600, processedVisual: 598, capturedAudio: 180, processedAudio: 180, dropped: 0,
        captureTimeline,
        discussionJournal: [{ role: "assistant", content: "这一步躲进储藏室挺机灵。", atMs: 500 }],
      },
    },
    finalize: { stored: true, cleanup: { complete: true }, completionAudit: { segmentId: 1, segmentSummaryRequests: 1 } },
  };
  report.environment.selectedWindowId = 42;
  assert.equal(validateRealStressReport(report, { expectedWindowId: 42 }), report);
  assert.throws(() => validateRealStressReport(report, { expectedWindowId: 43 }), /window binding/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, windowId: 43 },
  } }, { expectedWindowId: 42 }), /window binding/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, audio: captureTimeline.audio.filter((atMs) => atMs < startedAtMs + 29 * 60_000) } },
  } }), /capture continuity/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, visual: captureTimeline.visual.filter((atMs) => atMs < startedAtMs + 13 * 60_000 || atMs >= startedAtMs + 14 * 60_000) } },
  } }), /capture continuity/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, visual: captureTimeline.visual.filter((atMs) => atMs < startedAtMs + 5 * 60_000 + 9_000 || atMs >= startedAtMs + 5 * 60_000 + 39_000) } },
  } }), /capture continuity/, "a 30-second visual gap within a covered minute must fail");
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, audio: captureTimeline.audio.filter((atMs) => atMs < startedAtMs + 6 * 60_000 + 10_000 || atMs >= startedAtMs + 6 * 60_000 + 50_000) } },
  } }), /capture continuity/, "a 40-second audio gap within a covered minute must fail");
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, visual: captureTimeline.visual.filter((atMs) => atMs >= startedAtMs + 30_000) } },
  } }), /capture continuity/, "capture starting late must fail");
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, captureTimeline: { ...captureTimeline, audio: captureTimeline.audio.filter((atMs) => atMs < startedAtMs + 1_760_000) } },
  } }), /capture continuity/, "capture ending early must fail");
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    workspace: { ...report.beforeFinalize.workspace, discussionJournal: [] },
  } }), /dialogue record/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize, proactive: { totals: { completed: 0 }, events: [] } } }), /proactive/);
  for (const stream of [undefined, {}, { underrunCount: "0", maxGapMs: 0 }, { underrunCount: 0, maxGapMs: null }, { underrunCount: 1, maxGapMs: 0 }, { underrunCount: 0, maxGapMs: 25 }]) {
    const event = { ...report.beforeFinalize.proactive.events[0], tts: { ...report.beforeFinalize.proactive.events[0].tts, stream } };
    assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
      proactive: { ...report.beforeFinalize.proactive, events: [event] },
    } }), /proactive/);
  }
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    proactive: { ...report.beforeFinalize.proactive, totals: { ...report.beforeFinalize.proactive.totals, ttsIncomplete: 1 } },
  } }), /proactive playback/);
});

test("real stress runner rejects invalid window ids and non-loopback report URLs", () => {
  assert.throws(() => buildDevStressEnvironment({ windowId: 0, reportUrl: "http://127.0.0.1:1/report" }), /window id/);
  assert.throws(() => buildDevStressEnvironment({ windowId: 42, reportUrl: "https://example.com/report" }), /loopback/);
});

test("real stress report proves the requested dev model chain, isolation, duration, and cleanup", () => {
  const startedAtMs = 1_000_000;
  const report = {
    startedAtMs,
    durationMs: 1_800_000,
    plannedDurationMs: 1_800_000,
    environment: {
      buildKind: "debug",
      realServices: true,
      visionProvider: "mage-vl",
      asrProvider: "sensevoice",
      textProvider: "deepseek",
      voiceBackend: "voxcpm",
    },
    isolation: { supported: true, checks: 2, violations: [] },
    successfulTurns: 1,
    failedTurns: 0,
    turns: [{ ok: true, assistant: "他走进房间了。", ttsReceipt: {
      status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0,
      stream: { underrunCount: 0, maxGapMs: 0 },
    } }],
    beforeFinalize: {
      runtimeReceipts: Object.fromEntries([["vision", "mage-vl"], ["asr", "sensevoice"], ["text", "deepseek"]].map(([kind, provider]) => [kind, { provider, successfulResponses: 1, completedResponses: 1, failedResponses: 0 }])),
      workspace: { capturedVisual: 10, processedVisual: 8, capturedAudio: 4, processedAudio: 4, dropped: 0,
        captureTimeline: {
          visual: Array.from({ length: 600 }, (_, index) => startedAtMs + index * 3_000 + 5_000),
          audio: Array.from({ length: 180 }, (_, index) => startedAtMs + index * 10_000 + 9_000),
        },
      },
    },
    finalize: { stored: true, cleanup: { complete: true }, completionAudit: { segmentId: 1, segmentSummaryRequests: 1 } },
  };
  assert.equal(validateRealStressReport(report), report);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
    proactive: { events: [], totals: { ttsFailed: 1, ttsPartial: 0 } },
  } }), /proactive playback/);
  for (const status of ["failed", "partial"]) {
    assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize,
      proactive: { events: [{ status: "completed", tts: { status } }] },
    } }), /proactive playback/);
  }
  for (const stream of [undefined, {}, { underrunCount: 1, maxGapMs: 82 }, { underrunCount: 0, maxGapMs: 82 }, { underrunCount: 0 }, { underrunCount: "0", maxGapMs: 0 }, { underrunCount: -1, maxGapMs: 0 }, { underrunCount: 0, maxGapMs: null }, { underrunCount: 0, maxGapMs: "0" }]) {
    const turns = [{ ...report.turns[0], ttsReceipt: { ...report.turns[0].ttsReceipt, stream } }];
    assert.throws(() => validateRealStressReport({ ...report, turns }), /continuity/);
  }
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize, runtimeReceipts: null } }), /runtime/);
  assert.throws(() => validateRealStressReport({ ...report, isolation: { supported: false, checks: 2, violations: [] } }), /isolation/);
  assert.throws(() => validateRealStressReport({ ...report, environment: { ...report.environment, textProvider: "local" } }), /model chain/);
  assert.throws(() => validateRealStressReport({ ...report, isolation: { checks: 2, violations: [{ pid: 1 }] } }), /isolation/);
  assert.throws(() => validateRealStressReport({ ...report, durationMs: 1_799_999 }), /duration/);
  assert.throws(() => validateRealStressReport({ ...report, finalize: { cleanup: { complete: false } } }), /cleanup/);
  assert.throws(() => validateRealStressReport({ ...report, turns: [], successfulTurns: 0 }), /conversation/);
  assert.throws(() => validateRealStressReport({ ...report, failedTurns: 1, turns: [{ ok: false }] }), /conversation/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize, workspace: { capturedVisual: 0, processedVisual: 0, capturedAudio: 0, processedAudio: 0, dropped: 0 } } }), /media/);
  assert.throws(() => validateRealStressReport({ ...report, beforeFinalize: { ...report.beforeFinalize, workspace: { ...report.beforeFinalize.workspace, dropped: 1 } } }), /media/);
  assert.throws(() => validateRealStressReport({ ...report, turns: [{ ok: true, assistant: "回复", ttsReceipt: { status: "completed", requestedParts: 0 } }] }), /playback/);
  assert.throws(() => validateRealStressReport({ ...report, finalize: { ...report.finalize, stored: false } }), /summary/);
  assert.throws(() => validateRealStressReport({ ...report, finalize: { ...report.finalize, reason: "summary-fallback" } }), /summary/);
  assert.throws(() => validateRealStressReport({ ...report, finalize: { ...report.finalize, completionAudit: { segmentId: 0, segmentSummaryRequests: 0 } } }), /rollover/);
});

test("raw stress reports must stay outside the repository", () => {
  const external = path.join(tmpdir(), "kxyy-stress.json");
  assert.equal(path.basename(assertExternalReportPath(external)), "kxyy-stress.json");
  assert.throws(() => assertExternalReportPath("docs/test-reports/raw.json"), /outside the repository/);
});

test("external report paths cannot use a symlink back into the repository", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kxyy-report-link-"));
  try {
    const link = path.join(directory, "repo-link");
    symlinkSync(path.resolve("."), link, "dir");
    assert.throws(() => assertExternalReportPath(path.join(link, "private-report.json")), /outside the repository/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("adapter runner invokes capture, ASR, vision, DeepSeek, and TTS through explicit seams", async () => {
  let now = 0;
  const calls = [];
  const evidence = [];
  const report = await runSharedExperienceStressWithAdapters({
    plan: { durationMs: 2, turns: [{ atMs: 0, dynamic: true }] },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    adapters: {
      capture: { start: async () => calls.push("capture:start"), stop: async () => calls.push("capture:stop") },
      asr: { process: async () => { calls.push("asr"); evidence.push({ id: "a1", kind: "audio", text: "旁白说门开了" }); } },
      vision: { process: async () => { calls.push("vision"); evidence.push({ id: "v1", kind: "visual", text: "人物进入房间" }); } },
      deepseek: {
        question: async () => ({ prompt: "刚才是谁进入房间？", anchorEventIds: ["v1"] }),
        reply: async () => { calls.push("deepseek"); return { assistant: "刚才有人走进房间了。" }; },
      },
      tts: { speak: async () => { calls.push("tts"); return { status: "completed" }; } },
      snapshot: () => ({ workspace: { evidenceJournal: evidence } }),
      finish: async () => ({ cleanup: { complete: true } }),
      isolation: () => ({ checks: 1, violations: [] }),
    },
  });
  assert.deepEqual(calls, ["capture:start", "asr", "vision", "deepseek", "tts", "capture:stop"]);
  assert.equal(report.turns[0].assistant, "刚才有人走进房间了。");
  assert.equal(report.turns[0].ttsReceipt.status, "completed");
  assert.equal(report.environment.realServices, false);
  assert.deepEqual(report.isolation, { checks: 1, violations: [] });
});

test("adapter runner stops capture when an injected stage fails", async () => {
  let now = 0;
  let stops = 0;
  const report = await runSharedExperienceStressWithAdapters({
    plan: { durationMs: 1, turns: [{ atMs: 0, dynamic: true }] },
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    adapters: {
      capture: { start: async () => {}, stop: async () => { stops += 1; } },
      asr: { process: async () => { throw new Error("ASR unavailable"); } },
      vision: { process: async () => {} },
      deepseek: { question: async () => ({}), reply: async () => ({}) },
      tts: { speak: async () => ({}) },
      snapshot: () => ({ workspace: { evidenceJournal: [] } }),
      finish: async () => ({ cleanup: { complete: true } }),
      isolation: () => ({ checks: 1, violations: [] }),
    },
  });
  assert.equal(stops, 1);
  assert.equal(report.completedTurns, 0);
  assert.equal(report.skippedTurns, 1);
  assert.equal(report.adapterMetrics.asr.failures, 1);
});

test("simulation CLI completes immediately and writes only the explicit external report", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "kxyy-stress-sim-"));
  const output = path.join(directory, "report.json");
  try {
    const result = spawnSync(process.execPath, ["scripts/shared-experience/run-30min.mjs", "--simulate", "--output", output], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STRESS_REPORT_WRITTEN/);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.durationMs, 1_800_000);
    assert.equal(report.completedTurns, 90);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
