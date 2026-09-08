import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    assert.doesNotMatch(markdown, /- VoxCPM2：starts=/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
