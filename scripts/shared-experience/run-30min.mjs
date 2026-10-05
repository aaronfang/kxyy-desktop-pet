import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildStressPlan } from "./stress-plan-30min.mjs";
import { supportsProcessIsolation } from "./process-isolation.mjs";
import {
  buildSharedExperienceCleanupReceipt,
  runSharedExperienceAcceptancePlan,
} from "../../src/ai/shared-experience-acceptance.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../..");
const REAL_TEST_TIMEOUT_MS = 40 * 60 * 1000;

function simulationAdapters({ nowMs }) {
  const evidence = [];
  let sequence = 0;
  return {
    snapshot: () => ({
      workspace: {
        evidenceJournal: evidence.slice(),
        capturedVisual: sequence,
        processedVisual: sequence,
        capturedAudio: sequence,
        processedAudio: sequence,
        pending: 0,
        dropped: 0,
      },
    }),
    questionForTurn: ({ index, category }) => {
      const id = `sim-${++sequence}`;
      evidence.push({ id, kind: index % 2 ? "audio" : "visual", text: `模拟媒体证据 ${category || "current"} ${id}`, atMs: nowMs() });
      return {
        prompt: `根据刚才的内容，${category || "现在"}最明显的变化是什么？`,
        topic: category || "当前内容",
        anchorEventIds: [id],
        maturity: index < 6 ? "shallow" : "connecting",
      };
    },
    sendPrompt: async (prompt) => ({
      assistant: `模拟陪看回复：${prompt}`,
      usage: { requests: 1, prompt: 1, completion: 1, total: 2 },
      ttsReceipt: {
        status: "completed",
        requestedParts: 1,
        admittedParts: 1,
        startedParts: 1,
        completedParts: 1,
        failedParts: 0,
      },
    }),
  };
}

export async function runSharedExperienceStressSimulation({
  plan = buildStressPlan(),
  nowMs = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const adapters = simulationAdapters({ nowMs });
  let active = true;
  const report = await runSharedExperienceAcceptancePlan({
    plan,
    nowMs,
    sleep,
    snapshot: adapters.snapshot,
    questionForTurn: adapters.questionForTurn,
    sendPrompt: adapters.sendPrompt,
    finish: async () => {
      active = false;
      return { cleanup: buildSharedExperienceCleanupReceipt({ active, workspace: null, spool: null }) };
    },
  });
  return {
    ...report,
    environment: { buildKind: "dev-simulation", realServices: false, selectedWindow: "simulation" },
    isolation: { checks: 0, violations: [], simulated: true },
  };
}

export async function runSharedExperienceStressWithAdapters({
  plan = buildStressPlan(),
  adapters = {},
  nowMs = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const required = [
    ["capture.start", adapters.capture?.start],
    ["capture.stop", adapters.capture?.stop],
    ["asr.process", adapters.asr?.process],
    ["vision.process", adapters.vision?.process],
    ["deepseek.question", adapters.deepseek?.question],
    ["deepseek.reply", adapters.deepseek?.reply],
    ["tts.speak", adapters.tts?.speak],
    ["snapshot", adapters.snapshot],
    ["finish", adapters.finish],
    ["isolation", adapters.isolation],
  ];
  const missing = required.filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if (missing.length) throw new TypeError(`missing stress adapters: ${missing.join(", ")}`);

  const metrics = Object.fromEntries(["capture", "asr", "vision", "deepseek", "tts"].map((name) => [name, { calls: 0, failures: 0 }]));
  const invoke = async (name, operation) => {
    metrics[name].calls += 1;
    try { return await operation(); }
    catch (error) { metrics[name].failures += 1; throw error; }
  };
  let captureActive = false;
  const stopCapture = async () => {
    if (!captureActive) return;
    captureActive = false;
    await invoke("capture", () => adapters.capture.stop());
  };

  await invoke("capture", () => adapters.capture.start());
  captureActive = true;
  try {
    const report = await runSharedExperienceAcceptancePlan({
      plan,
      nowMs,
      sleep,
      snapshot: adapters.snapshot,
      waitForStart: adapters.waitForStart || (async () => {}),
      questionForTurn: async (context) => {
        try {
          await invoke("asr", () => adapters.asr.process(context));
          await invoke("vision", () => adapters.vision.process(context));
          return await invoke("deepseek", () => adapters.deepseek.question({ ...context, snapshot: adapters.snapshot() }));
        } catch {
          return {};
        }
      },
      sendPrompt: async (prompt, index, question) => {
        const reply = await invoke("deepseek", () => adapters.deepseek.reply({ prompt, index, question, snapshot: adapters.snapshot() }));
        const ttsReceipt = await invoke("tts", () => adapters.tts.speak(reply?.assistant || "", { index, question }));
        return { ...reply, ttsReceipt };
      },
      finish: async () => {
        await stopCapture();
        return adapters.finish();
      },
    });
    return {
      ...report,
      environment: {
        buildKind: "dev-adapter",
        realServices: false,
      },
      isolation: adapters.isolation(),
      adapterMetrics: metrics,
    };
  } finally {
    await stopCapture();
  }
}

export function assertExternalReportPath(value) {
  const resolved = path.resolve(String(value || ""));
  // Resolve the nearest existing ancestor, including /tmp and directory symlinks.
  let ancestor = resolved;
  const missing = [];
  let canonical;
  for (;;) {
    try { canonical = path.join(realpathSync(ancestor), ...missing); break; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const relative = path.relative(realpathSync(rootDir), canonical);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("raw report output must stay outside the repository");
  }
  return resolved;
}

export function buildDevStressEnvironment({
  windowId,
  reportUrl,
  userStatement = "",
  plan = buildStressPlan(),
  showDebug = true,
  proactiveEnabled = true,
  proactiveOnly = false,
} = {}) {
  const id = Number(windowId);
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new TypeError("a valid positive window id is required");
  const reportUrlText = String(reportUrl || "");
  let parsedReportUrl;
  try { parsedReportUrl = new URL(reportUrlText); } catch {}
  if (!parsedReportUrl || parsedReportUrl.protocol !== "http:" || parsedReportUrl.hostname !== "127.0.0.1"
    || parsedReportUrl.pathname !== "/report" || parsedReportUrl.search || parsedReportUrl.hash
    || !parsedReportUrl.port || Number(parsedReportUrl.port) > 65535) {
    throw new TypeError("report URL must be a loopback /report endpoint");
  }
  return {
    KXYY_SHOW_CHAT_ON_START: "1",
    KXYY_START_SHARED_EXPERIENCE_WINDOW_ID: String(id),
    KXYY_SHARED_EXPERIENCE_TEST_PLAN_JSON: JSON.stringify(proactiveOnly
      ? { durationMs: plan.durationMs, turns: [] }
      : plan),
    KXYY_SHARED_EXPERIENCE_REPORT_URL: reportUrlText,
    KXYY_SHARED_EXPERIENCE_TEST_DEBUG: showDebug ? "1" : "0",
    KXYY_SHARED_EXPERIENCE_PROACTIVE_ENABLED: proactiveEnabled ? "1" : "0",
    ...(!proactiveOnly && String(userStatement).trim()
      ? { KXYY_SHARED_EXPERIENCE_USER_STATEMENT: String(userStatement).trim() }
      : {}),
  };
}

export function validateRealStressReport(report, { expectedWindowId } = {}) {
  const environment = report?.environment || {};
  if (expectedWindowId !== undefined && (!Number.isInteger(Number(expectedWindowId))
    || Number(expectedWindowId) !== Number(environment.selectedWindowId)
    || Number(expectedWindowId) !== Number(report?.beforeFinalize?.workspace?.windowId))) {
    throw new Error("real report failed window binding verification");
  }
  const actualChain = [
    environment.visionProvider,
    environment.asrProvider,
    environment.textProvider,
    environment.voiceBackend,
  ].map((value) => String(value || "").toLowerCase());
  if (environment.buildKind !== "debug" || environment.realServices !== true
    || actualChain.join("|") !== "mage-vl|sensevoice|deepseek|voxcpm") {
    throw new Error("real report did not use the required debug model chain");
  }
  if (!Number.isFinite(report.durationMs) || report.durationMs < 30 * 60 * 1000) {
    throw new Error("real report did not reach the 30-minute duration");
  }
  if (report?.isolation?.supported !== true || !Number.isFinite(report?.isolation?.checks) || report.isolation.checks < 1
    || !Array.isArray(report.isolation.violations) || report.isolation.violations.length) {
    throw new Error("real report failed process isolation verification");
  }
  if (report?.finalize?.cleanup?.complete !== true) {
    throw new Error("real report failed cleanup verification");
  }
  const turns = report.turns;
  const proactiveOnly = environment.testMode === "proactive-only";
  if (proactiveOnly) {
    if (!Array.isArray(turns) || turns.length || report.plannedTurns !== 0
      || report.successfulTurns !== 0 || report.failedTurns !== 0
      || !positiveProactiveCompletion(report.beforeFinalize?.proactive)
      || report.beforeFinalize?.voiceService?.backend !== "voxcpm"
      || report.beforeFinalize.voiceService.runningSeen !== true) {
      throw new Error("real report failed proactive conversation verification");
    }
  } else if (!Array.isArray(turns) || turns.length === 0 || report.successfulTurns !== turns.length
    || report.failedTurns !== 0 || turns.some((turn) => turn.ok !== true || !String(turn.assistant || "").trim())) {
    throw new Error("real report failed conversation verification");
  }
  const media = report.beforeFinalize?.workspace || {};
  if (proactiveOnly && (!Array.isArray(media.discussionJournal)
    || !media.discussionJournal.some((turn) => turn?.role === "assistant" && String(turn.content || "").trim()))) {
    throw new Error("real report failed proactive dialogue record verification");
  }
  const positiveCount = (value) => Number.isSafeInteger(value) && value > 0;
  const completedCount = (entry) => positiveCount(entry?.completedResponses)
    && entry.completedResponses <= entry.successfulResponses;
  const runtime = report.beforeFinalize?.runtimeReceipts;
  if ([["vision", "mage-vl"], ["asr", "sensevoice"], ["text", "deepseek"]].some(([kind, provider]) =>
    runtime?.[kind]?.provider !== provider || !positiveCount(runtime?.[kind]?.successfulResponses)
      || !completedCount(runtime?.[kind]))) {
    throw new Error("real report failed runtime response verification");
  }
  if (![media.capturedVisual, media.processedVisual, media.capturedAudio, media.processedAudio].every(positiveCount)
    || media.processedVisual > media.capturedVisual || media.processedAudio > media.capturedAudio || media.dropped !== 0) {
    throw new Error("real report failed media processing/loss verification");
  }
  const captureWindowMs = 30 * 60 * 1000;
  for (const [kind, maxGapMs] of [["visual", 15_000], ["audio", 30_000]]) {
    const timeline = media.captureTimeline?.[kind];
    const samples = (Array.isArray(timeline) ? timeline : [])
      .filter((atMs) => Number.isFinite(atMs) && atMs >= report.startedAtMs
        && atMs <= report.startedAtMs + captureWindowMs)
      .sort((a, b) => a - b);
    const boundaries = [report.startedAtMs, ...samples, report.startedAtMs + captureWindowMs];
    if (!Number.isFinite(report.startedAtMs) || !samples.length
      || boundaries.some((atMs, index) => index > 0 && atMs - boundaries[index - 1] > maxGapMs)) {
      throw new Error(`real report failed ${kind} capture continuity verification`);
    }
  }
  if (turns.some(({ ttsReceipt: receipt }) => receipt?.status !== "completed"
    || receipt.backend !== "voxcpm"
    || !positiveCount(receipt.requestedParts) || receipt.failedParts !== 0
    || receipt.requestedParts !== receipt.admittedParts || receipt.admittedParts !== receipt.startedParts
    || receipt.startedParts !== receipt.completedParts)) {
    throw new Error("real report failed audible playback verification");
  }
  if (turns.some(({ ttsReceipt: receipt }) => !receipt?.stream
    || !Number.isInteger(receipt.stream.underrunCount) || receipt.stream.underrunCount < 0
    || typeof receipt.stream.maxGapMs !== "number" || !Number.isFinite(receipt.stream.maxGapMs) || receipt.stream.maxGapMs < 0
    || receipt.stream.underrunCount !== 0 || receipt.stream.maxGapMs !== 0)) {
    throw new Error("real report failed TTS continuity verification");
  }
  if (report.finalize.stored !== true || report.finalize.reason === "summary-fallback" || report.finalizeError) {
    throw new Error("real report failed reviewed summary persistence verification");
  }
  if (Number(report.beforeFinalize?.proactive?.totals?.ttsFailed) > 0
    || Number(report.beforeFinalize?.proactive?.totals?.ttsPartial) > 0
    || Number(report.beforeFinalize?.proactive?.totals?.ttsIncomplete) > 0
    || (report.beforeFinalize?.proactive?.events || []).some((event) =>
    ["failed", "partial"].includes(event.tts?.status)
    || ["tts-failed", "tts-partial", "tts-incomplete"].includes(event.failureReason))) {
    throw new Error("real report failed proactive playback verification");
  }
  const audit = report.finalize.completionAudit || {};
  if (!positiveCount(audit.segmentId) || !positiveCount(audit.segmentSummaryRequests)) {
    throw new Error("real report failed rollover verification");
  }
  return report;
}

export function positiveProactiveCompletion(proactive) {
  return Number.isSafeInteger(proactive?.totals?.completed) && proactive.totals.completed > 0
    && Array.isArray(proactive.events)
    && proactive.events.some((event) => event.status === "completed"
      && event.tts?.status === "completed" && event.tts?.backend === "voxcpm"
      && Number.isSafeInteger(event.tts.requestedParts) && event.tts.requestedParts > 0
      && event.tts.requestedParts === event.tts.admittedParts
      && event.tts.admittedParts === event.tts.startedParts
      && event.tts.startedParts === event.tts.completedParts && event.tts.failedParts === 0
      && event.tts.stream?.underrunCount === 0 && event.tts.stream?.maxGapMs === 0);
}

function timeoutAfter(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  timer.unref?.();
  return promise;
}

function outputLines(stream, destination, onLine = () => {}) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    destination.write(chunk);
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      onLine(line);
    }
  });
}

export async function terminateOwnedProcess(child) {
  if (!child?.pid) return;
  // The npm leader may have exited while its detached dev children are still alive.
  try {
    if (platform() === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  if (child.exitCode == null && child.signalCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (platform() !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

export function installStressSignalHandlers(cancel, signals = process) {
  let interrupted = false;
  const handlers = Object.fromEntries(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    if (interrupted) return;
    interrupted = true;
    cancel(signal);
  }]));
  for (const [signal, handler] of Object.entries(handlers)) signals.on(signal, handler);
  return () => { for (const [signal, handler] of Object.entries(handlers)) signals.removeListener(signal, handler); };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : "";
  };
  return {
    simulate: argv.includes("--simulate"),
    output: value("--output"),
    windowId: value("--window-id"),
    userStatement: value("--user-statement"),
    showDebug: !argv.includes("--no-debug"),
    proactiveEnabled: !argv.includes("--no-proactive"),
    proactiveOnly: !argv.includes("--scripted-questions"),
  };
}

async function runRealStressTest(options) {
  if (!options.output) throw new Error("Usage: run-30min.mjs --window-id ID --output /tmp/report.json [--user-statement TEXT]");
  const outputPath = assertExternalReportPath(options.output);
  if (!supportsProcessIsolation()) throw new Error("real stress capture/isolation currently supports macOS only");
  buildDevStressEnvironment({ ...options, reportUrl: "http://127.0.0.1:1/report" });
  try {
    await access(outputPath);
    throw new Error("raw report output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const reportServer = spawn(process.execPath, [path.join(scriptDir, "stress-report-server.mjs"), outputPath, "0"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let dev = null;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const disposeSignals = installStressSignalHandlers((signal) => rejectInterrupted(new Error(`stress test interrupted (${signal})`)));
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  outputLines(reportServer.stdout, process.stdout, (line) => {
    const match = line.match(/^REPORT_LISTENING (http:\/\/127\.0\.0\.1:\d+\/report)$/);
    if (match) resolveReady(match[1]);
  });
  outputLines(reportServer.stderr, process.stderr);
  reportServer.once("error", rejectReady);
  reportServer.once("exit", (code) => {
    if (code !== 0) rejectReady(new Error(`report server exited before readiness (${code})`));
  });
  try {
    const reportUrl = await Promise.race([
      ready,
      interrupted,
      timeoutAfter(10_000, "report server readiness timeout"),
    ]);
    const injected = buildDevStressEnvironment({ ...options, reportUrl });
    const npm = platform() === "win32" ? "npm.cmd" : "npm";
    dev = spawn(npm, ["run", "dev"], {
      cwd: rootDir,
      env: { ...process.env, ...injected },
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    outputLines(dev.stdout, process.stdout);
    outputLines(dev.stderr, process.stderr);
    const reportStored = new Promise((resolve, reject) => {
      reportServer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`report server failed (${code})`)));
      reportServer.once("error", reject);
    });
    const devExited = new Promise((_, reject) => {
      dev.once("exit", (code, signal) => reject(new Error(`dev app exited before report (${code ?? signal})`)));
      dev.once("error", reject);
    });
    await Promise.race([
      reportStored,
      interrupted,
      devExited,
      timeoutAfter(REAL_TEST_TIMEOUT_MS, "30-minute test timed out"),
    ]);
    return validateRealStressReport(JSON.parse(await readFile(outputPath, "utf8")), {
      expectedWindowId: options.windowId,
    });
  } finally {
    await terminateOwnedProcess(dev);
    await terminateOwnedProcess(reportServer);
    disposeSignals();
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.output) throw new Error("--output is required; use a path outside the repository for raw reports");
  if (options.simulate) {
    let simulatedNow = 0;
    const report = await runSharedExperienceStressSimulation({
      nowMs: () => simulatedNow,
      sleep: async (ms) => { simulatedNow += ms; },
    });
    const outputPath = assertExternalReportPath(options.output);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`STRESS_REPORT_WRITTEN ${outputPath}\n`);
    return;
  }
  await runRealStressTest(options);
  process.stdout.write(`STRESS_TEST_COMPLETE ${path.resolve(options.output)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
