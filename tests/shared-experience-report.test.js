import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("stress report requires explicit input and output paths", () => {
  const result = spawnSync(process.execPath, ["scripts/shared-experience/generate-stress-report.mjs"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: generate-stress-report\.mjs raw\.json report\.md/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("fixed-question report uses its captured review sources, never the final scene", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-experience-report-"));
  try {
    const rawPath = path.join(directory, "raw.json");
    const reportPath = path.join(directory, "report.md");
    writeFileSync(rawPath, JSON.stringify({ startedAtMs: 1000, endedAtMs: 301000, durationMs: 300000,
      turns: [{ index: 1, startedAtMs: 35000, anchorEventIds: [], prompt: "现在在哪？", assistant: "室内",
        groundingAudit: { repairAttempted:true, repaired:true, repairedDraft:"纠正后答复：室内。", evidence: [{ id: "early", kind: "visual", text: "同期角色走进室内。" }] } }],
      beforeFinalize: { workspace: { evidenceJournal: [{ id: "late", kind: "visual", atMs: 300000, text: "后续角色走到海边。" }] } },
    }));
    execFileSync(process.execPath, ["scripts/shared-experience/generate-quality-report.mjs", rawPath, reportPath]);
    const markdown = readFileSync(reportPath, "utf8");
    assert.match(markdown, /同期角色走进室内/);
    assert.doesNotMatch(markdown, /后续角色走到海边/);
    assert.match(markdown,/纠正后答复：室内/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stress report uses the service lifecycle fields that the runner records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-experience-report-"));
  try {
    const rawPath = path.join(directory, "raw.json");
    const reportPath = path.join(directory, "report.md");
    writeFileSync(rawPath, JSON.stringify({
      startedAtMs: 1,
      endedAtMs: 1_800_001,
      durationMs: 1_800_000,
      successfulTurns: 1,
      failedTurns: 0,
      turns: [{
        index: 1,
        ok: true,
        anchorEventIds: ["e1"],
        ttsReceipt: {
          status: "completed",
          requestedParts: 1,
          admittedParts: 1,
          startedParts: 1,
          completedParts: 1,
          failedParts: 0,
          stream: { underrunCount: 0, maxGapMs: 0 },
        },
      }],
      beforeFinalize: {
        voiceService: { runningSeen: true, failures: 0, unexpectedRestarts: 0 },
        workspace: {
          evidenceJournal: [{ id: "e1", kind: "audio", text: "旁白" }],
          capturedVisual: 10, processedVisual: 8, capturedAudio: 4, processedAudio: 4,
          pending: 2, bytes: 1234, peakPending: 3, peakBytes: 2345,
          dropped: 1, droppedByKind: { visual: 1, audio: 0, unknown: 0 },
        },
      },
      finalize: {
        completionAudit: { segmentId: 1, segmentSummaryRequests: 1 },
        cleanup: { complete: true, captureStopped: true, workspaceReleased: true, spoolReleased: true, pending: 0 },
      },
      isolation: { checks: 1, violations: [] },
    }));
    execFileSync(process.execPath, ["scripts/shared-experience/generate-stress-report.mjs", rawPath, reportPath], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      stdio: "pipe",
    });
    const markdown = readFileSync(reportPath, "utf8");
    assert.match(markdown, /runningSeen=true，failures=0，unexpectedRestarts=0/);
    assert.match(markdown, /推理积压峰值.*3 条；2345 bytes/);
    assert.match(markdown, /spool 丢弃.*1 条/);
    assert.match(markdown, /自动验收结论：\*\*不通过\*\*/);
    assert.doesNotMatch(markdown, /- VoxCPM2：starts=/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stress report does not describe an unpriced model as free", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-experience-report-"));
  try {
    const rawPath = path.join(directory, "raw.json");
    const reportPath = path.join(directory, "report.md");
    writeFileSync(rawPath, JSON.stringify({
      startedAtMs: 1, endedAtMs: 1_800_001, durationMs: 1_800_000,
      turns: [], beforeFinalize: { workspace: {}, lifecycle: {} },
      finalize: {},
    }));
    execFileSync(process.execPath, ["scripts/shared-experience/generate-stress-report.mjs", rawPath, reportPath]);
    assert.match(readFileSync(reportPath, "utf8"), /估算未确认，不能据此认定免费/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("proactive-only report accepts zero scripted turns and prints the observed dialogue", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-experience-report-"));
  try {
    const rawPath = path.join(directory, "raw.json");
    const reportPath = path.join(directory, "report.md");
    writeFileSync(rawPath, JSON.stringify({
      startedAtMs: 1, endedAtMs: 1_800_001, durationMs: 1_800_000,
      plannedTurns: 0, successfulTurns: 0, failedTurns: 0, turns: [],
      environment: { buildKind: "debug", realServices: true, visionProvider: "mage-vl", asrProvider: "sensevoice", textProvider: "deepseek", voiceBackend: "voxcpm", testMode: "proactive-only" },
      isolation: { supported: true, checks: 1, violations: [] },
      beforeFinalize: {
        proactive: { totals: { completed: 1, failed: 0, ttsFailed: 0, ttsPartial: 0, ttsIncomplete: 0 }, events: [{ status: "completed", tts: { status: "completed", backend: "voxcpm", requestedParts: 1, admittedParts: 1, startedParts: 1, completedParts: 1, failedParts: 0, stream: { underrunCount: 0, maxGapMs: 0 } } }] },
        voiceService: { backend: "voxcpm", runningSeen: true, failures: 0, unexpectedRestarts: 0 },
        runtimeReceipts: Object.fromEntries([["vision", "mage-vl"], ["asr", "sensevoice"], ["text", "deepseek"]].map(([kind, provider]) => [kind, { provider, successfulResponses: 1, completedResponses: 1 }])),
        workspace: { capturedVisual: 2, processedVisual: 2, capturedAudio: 1, processedAudio: 1, dropped: 0,
          captureTimeline: {
            visual: Array.from({ length: 600 }, (_, index) => index * 3_000 + 5_001),
            audio: Array.from({ length: 180 }, (_, index) => index * 10_000 + 9_001),
          },
          evidenceJournal: [{ id: "ev-1", kind: "audio", atMs: 100, text: "解说说角色躲进了储藏室。" }],
          discussionJournal: [{ role: "assistant", content: "躲进储藏室这步挺机灵。", atMs: 500, includeInSummary: false }],
        },
      },
      finalize: { stored: true, cleanup: { complete: true, captureStopped: true, workspaceReleased: true, spoolReleased: true, pending: 0 }, completionAudit: { segmentId: 1, segmentSummaryRequests: 1 } },
    }));
    execFileSync(process.execPath, ["scripts/shared-experience/generate-stress-report.mjs", rawPath, reportPath]);
    const markdown = readFileSync(reportPath, "utf8");
    assert.match(markdown, /自动验收结论：\*\*通过\*\*/);
    assert.match(markdown, /画面逐分钟采集覆盖 \| 30\/30 分钟/);
    assert.match(markdown, /音频逐分钟采集覆盖 \| 30\/30 分钟/);
    assert.match(markdown, /画面最大采集间隔（含首尾） \| \d+ ms；门槛 15000 ms/);
    assert.match(markdown, /音频最大采集间隔（含首尾） \| \d+ ms；门槛 30000 ms/);
    assert.match(markdown, /主动陪看最近对话记录（最多 256 条）/);
    assert.match(markdown, /超过上限的早期发言不在此快照中/);
    assert.match(markdown, /躲进储藏室这步挺机灵/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
