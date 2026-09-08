import { readFile, writeFile } from "node:fs/promises";
import { buildCurrentEvidenceWindow } from "../../src/ai/shared-experience-evidence-window.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: generate-quality-report.mjs raw.json report.md");
const report = JSON.parse(await readFile(input, "utf8"));
const turns = report.turns || [];
const workspace = report.beforeFinalize?.workspace || {};
const journal = workspace.evidenceJournal || [];
const lifecycle = report.finalize?.completionAudit?.lifecycle || report.beforeFinalize?.lifecycle || {};
const usage = lifecycle.usage || {};
const time = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const metric = (values) => {
  const valid = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  return valid.length ? `n=${valid.length}, p50=${Math.round(valid[Math.ceil(valid.length * .5) - 1])}ms, p95=${Math.round(valid[Math.ceil(valid.length * .95) - 1])}ms` : "未记录";
};
const transcript = turns.map((turn) => {
  const anchors = turn.anchorEventIds || [];
  const focusText = anchors.length
    ? buildCurrentEvidenceWindow(journal, { focusEvidenceIds: anchors }).text
    : (turn.groundingAudit?.evidence || []).filter((event) => ["audio", "visual"].includes(event.kind))
      .slice(-6).map((event) => `[${event.id}] ${event.kind}: ${event.text}`).join("\n") || "未记录本轮证据快照，不使用结束时画面替代。";
  return `### 第 ${turn.index} 轮 (${time(turn.startedAtMs)})

问题：${turn.prompt}

回复：${turn.assistant || "未返回"}

具体短语：${turn.questionTopic || "未记录"}；锚点：${anchors.join(", ")}；成功：${turn.ok}

同期证据（${anchors.length ? "仅到锚点时间" : "本轮审查时固定快照"}，不使用后续观察）：

${focusText.split("\n").map((line) => `> ${line}`).join("\n")}

TTS 回执：${JSON.stringify(turn.ttsReceipt || null)}

${turn.groundingAudit?.repairAttempted ? `有界纠正：已尝试；通过=${turn.groundingAudit.repaired}；纠正后草稿：${turn.groundingAudit.repairedDraft || "未通过或未记录"}\n` : ""}

${turn.groundingAudit ? `朗读前审查：通过=${turn.groundingAudit.accepted}；删除片段=${turn.groundingAudit.removedParts}；耗时=${turn.groundingAudit.reviewMs}ms\n\n审查前草稿：${turn.groundingAudit.draft || "未记录"}\n\n保留来源：${JSON.stringify(turn.groundingAudit.supports || [])}\n\n审查时固定来源快照：\n\n${(turn.groundingAudit.evidence || []).map((event) => `> [${event.id}] ${event.kind}: ${event.text}`).join("\n")}\n` : ""}

提问生成：${turn.questionGenerationMs ?? "未记录"}ms；回复及播放含提问生成：${turn.responseMs}ms
`;
}).join("\n");
const markdown = `# 共同体验内容质量短测

本报告记录运行结果和逐轮证据，不自动宣称理解准确或内容质量通过。人工审阅结论另附。

- 实测时间：${new Date(report.startedAtMs).toISOString()} 至 ${new Date(report.endedAtMs).toISOString()}
- 持续 ${(report.durationMs / 1000).toFixed(1)} 秒；目标 ${report.plannedDurationMs / 1000} 秒
- 完成 ${turns.length} 轮；成功 ${report.successfulTurns}；失败 ${report.failedTurns}；跳过 ${report.skippedTurns}
- 环境：${JSON.stringify(report.environment)}
- 进程隔离：${JSON.stringify(report.isolation)}
- 采集/处理：画面 ${workspace.capturedVisual}/${workspace.processedVisual}；音频 ${workspace.capturedAudio}/${workspace.processedAudio}
- 推理积压：峰值 ${workspace.peakPending ?? "未记录"} 条（${workspace.peakBytes ?? "未记录"} bytes）；结束前 ${workspace.pending ?? "未记录"} 条（${workspace.bytes ?? "未记录"} bytes）
- spool 丢弃：共 ${workspace.dropped ?? "未记录"} 条；按类型 ${JSON.stringify(workspace.droppedByKind || {})}
- 证据 ${journal.length} 条，压缩块 ${(workspace.evidenceBlocks || []).length} 个；视觉身份过滤 ${workspace.filteredVisualIdentities}
- Primer：${JSON.stringify(workspace.primerGate)}
- TTS 首音频：${metric(turns.map((turn) => turn.ttsReceipt?.firstAudioMs))}
- 回复及播放：${metric(turns.map((turn) => turn.responseMs))}
- 播放连续性逐轮记录在下方；零 underrun 仅代表已采样流内指标，不等同跨句无间隙
- 结束释放：${JSON.stringify(report.finalize?.cleanup)}

## 费用

${Object.entries(usage).map(([kind, bucket]) => `- ${kind}: ${bucket.requests} 请求，输入 ${bucket.prompt}，输出 ${bucket.completion}，估算 $${bucket.estimatedCostUsd}`).join("\n")}
- 总预算：${JSON.stringify(lifecycle.budget)}
- 余额快照：${JSON.stringify(lifecycle.balance)}

## 最终总结

${report.finalize?.summary || "未生成"}

Memory 回执：stored=${report.finalize?.stored}, duplicate=${report.finalize?.duplicate}, reason=${report.finalize?.reason}

## 完整对话

${transcript}
`;
await writeFile(output, markdown);
console.log(`Wrote ${output}: ${turns.length} turns; semantic quality requires review`);
