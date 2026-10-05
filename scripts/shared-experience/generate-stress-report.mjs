import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { filterVisualIdentityClaims } from "../../src/ai/shared-experience-visual-identity.js";
import { findSharedExperienceAuditStyle } from "../../src/ai/shared-experience-dialogue-style.js";
import { parseSharedExperienceViewingStatement } from "../../src/ai/shared-experience-primer.js";
import { assertExternalReportPath, positiveProactiveCompletion, validateRealStressReport } from "./run-30min.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../..");
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: generate-stress-report.mjs raw.json report.md");
const rawPath = path.resolve(rootDir, input);
const reportPath = assertExternalReportPath(output);
const report = JSON.parse(await readFile(rawPath, "utf8"));

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentile(values, fraction) {
  const sorted = values.map(number).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + number(value), 0) / values.length : 0;
}

function seconds(ms) {
  return `${(number(ms) / 1000).toFixed(3)} 秒`;
}

function elapsed(ms) {
  const totalSeconds = Math.floor(number(ms) / 1000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function localTime(ms) {
  if (!number(ms)) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(ms));
}

function countBy(values, keyOf) {
  return values.reduce((counts, value) => {
    const key = String(keyOf(value) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function inlineCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join("，") : "无";
}

function usageLine(bucket = {}) {
  return `${number(bucket.requests)} 请求；${number(bucket.prompt).toLocaleString()} prompt + ${number(bucket.completion).toLocaleString()} completion = ${number(bucket.total).toLocaleString()} tokens`;
}

function receiptState(receipt) {
  if (!receipt || typeof receipt !== "object") return "missing";
  return String(receipt.status || receipt.state || (receipt.completed ? "completed" : receipt.error ? "failed" : "unknown"));
}

function receiptMetric(receipt, keys) {
  if (!receipt || typeof receipt !== "object") return 0;
  for (const key of keys) {
    const value = Number(receipt[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

const turns = Array.isArray(report.turns) ? report.turns : [];
const proactiveOnly = report.environment?.testMode === "proactive-only";
const before = report.beforeFinalize || {};
const lifecycle = before.lifecycle || {};
const workspace = before.workspace || {};
const discussion = Array.isArray(workspace.discussionJournal) ? workspace.discussionJournal : [];
const proactive = before.proactive || {};
const completionAudit = report.finalize?.completionAudit || {};
const finalLifecycle = completionAudit.lifecycle || lifecycle;
const usage = finalLifecycle.usage || lifecycle.usage || {};
const budget = finalLifecycle.budget || lifecycle.budget || {};
const balance = finalLifecycle.balance || lifecycle.balance || {};
const voice = before.voiceService || {};
const isolation = report.isolation || {};
const evidence = Array.isArray(workspace.evidenceJournal) ? workspace.evidenceJournal : [];
const blocks = Array.isArray(workspace.evidenceBlocks) ? workspace.evidenceBlocks : [];
const responseTimes = turns.map((turn) => number(turn.responseMs));
const scheduleLags = turns.map((turn) => number(turn.scheduleLagMs));
const anchoredTurns = turns.filter((turn) => Array.isArray(turn.anchorEventIds) && turn.anchorEventIds.length > 0);
const maturities = countBy(turns, (turn) => turn.maturity);
const evidenceKinds = countBy(evidence, (event) => event.kind);
const visualIdentityLeaks = evidence.filter((event) => event.kind === "visual" && filterVisualIdentityClaims(event.text).identityFiltered);
const evidenceById = new Map(evidence.map((event) => [event.id, event]));
// Early anchors may have left the bounded journal; use the same-turn captured sources.
for (const turn of turns) {
  for (const event of turn.groundingAudit?.evidence || []) {
    if (event?.id && !evidenceById.has(event.id)) evidenceById.set(event.id, event);
  }
}
const skippedTurnDetails = Array.isArray(report.skippedTurnDetails) ? report.skippedTurnDetails : [];
const anchorKinds = countBy(
  turns.flatMap((turn) => Array.isArray(turn.anchorEventIds) ? turn.anchorEventIds : []),
  (id) => evidenceById.get(id)?.kind || "missing",
);
const receiptCounts = countBy(turns, (turn) => receiptState(turn.ttsReceipt));
const ttfaValues = turns.map((turn) => receiptMetric(turn.ttsReceipt, ["firstAudioMs", "ttfaMs", "timeToFirstAudioMs"])).filter((value) => value > 0);
const ttsTotalValues = turns.map((turn) => receiptMetric(turn.ttsReceipt, ["totalMs", "durationMs", "completedMs"])).filter((value) => value > 0);
const ttsParts = turns.reduce((totals, turn) => {
  const receipt = turn.ttsReceipt || {};
  for (const key of Object.keys(totals)) totals[key] += number(receipt[key]);
  return totals;
}, { requestedParts: 0, admittedParts: 0, startedParts: 0, completedParts: 0, failedParts: 0 });
const underrunCounts = turns.map((turn) => number(turn.ttsReceipt?.stream?.underrunCount));
const streamGapValues = turns.map((turn) => number(turn.ttsReceipt?.stream?.maxGapMs));
const isolationViolations = Array.isArray(isolation.violations) ? isolation.violations : [];
const primerEvents = evidence.filter((event) => event.kind === "primer");
const viewingStatement = parseSharedExperienceViewingStatement(report.environment?.userViewingStatement);
const primerAuthorizationOk = primerEvents.length === 0 || Boolean(viewingStatement);
const primerGateStatus = String(workspace.primerGate?.status || "not-reported");
const auditStyleTurns = turns
  .map((turn) => ({ index: turn.index, findings: findSharedExperienceAuditStyle(turn.assistant) }))
  .filter((turn) => turn.findings.length);
const durationOk = number(report.durationMs) >= 30 * 60 * 1000;
const turnsOk = proactiveOnly
  ? turns.length === 0 && number(report.plannedTurns) === 0 && positiveProactiveCompletion(proactive)
  : turns.length > 0 && number(report.successfulTurns) === turns.length && number(report.failedTurns) === 0;
const anchorsOk = proactiveOnly || (turns.length > 0 && anchoredTurns.length === turns.length
  && turns.every((turn) => turn.anchorEventIds.every((id) => evidenceById.has(id))));
const isolationOk = isolation.supported === true && number(isolation.checks) > 0 && isolationViolations.length === 0;
const finalSegmentId = Number.isFinite(Number(completionAudit.segmentId))
  ? Number(completionAudit.segmentId)
  : number(workspace.segmentId);
const segmentSummaryRequests = Number.isFinite(Number(completionAudit.segmentSummaryRequests))
  ? Number(completionAudit.segmentSummaryRequests)
  : number(usage.segmentSummary?.requests);
const rolloverOk = finalSegmentId >= 1 && segmentSummaryRequests >= 1;
const receiptsOk = proactiveOnly
  ? positiveProactiveCompletion(proactive)
    && number(proactive.totals?.ttsFailed) === 0 && number(proactive.totals?.ttsPartial) === 0
    && number(proactive.totals?.ttsIncomplete) === 0
  : turns.length > 0 && !receiptCounts.missing && !receiptCounts.failed && !receiptCounts.partial;
const ttsPartsOk = proactiveOnly ? receiptsOk : ttsParts.requestedParts > 0
  && ttsParts.requestedParts === ttsParts.admittedParts
  && ttsParts.admittedParts === ttsParts.startedParts
  && ttsParts.startedParts === ttsParts.completedParts
  && ttsParts.failedParts === 0;
const streamContinuityOk = proactiveOnly ? receiptsOk : (turns.length > 0
  && turns.every((turn) => Number.isFinite(Number(turn.ttsReceipt?.stream?.underrunCount)))
  && underrunCounts.every((count) => count === 0)
  && streamGapValues.every((gap) => gap === 0));
const restartsOk = number(voice.unexpectedRestarts) === 0;
const visualIdentityOk = visualIdentityLeaks.length === 0;
const dialogueStyleOk = auditStyleTurns.length === 0;
const cleanup = report.finalize?.cleanup || {};
const cleanupOk = cleanup.complete === true
  && cleanup.captureStopped === true
  && cleanup.workspaceReleased === true
  && cleanup.spoolReleased === true
  && number(cleanup.pending) === 0;
let runtimeGateError = "";
try { validateRealStressReport(report); } catch (error) { runtimeGateError = error.message; }
const captureMinutes = (kind) => new Set((Array.isArray(workspace.captureTimeline?.[kind])
  ? workspace.captureTimeline[kind] : [])
  .filter((atMs) => Number.isFinite(atMs) && atMs >= report.startedAtMs && atMs < report.startedAtMs + 1_800_000)
  .map((atMs) => Math.floor((atMs - report.startedAtMs) / 60_000))).size;
const maxCaptureGapMs = (kind) => {
  const samples = (Array.isArray(workspace.captureTimeline?.[kind]) ? workspace.captureTimeline[kind] : [])
    .filter((atMs) => Number.isFinite(atMs) && atMs >= report.startedAtMs && atMs <= report.startedAtMs + 1_800_000)
    .sort((a, b) => a - b);
  const boundaries = [report.startedAtMs, ...samples, report.startedAtMs + 1_800_000];
  return boundaries.reduce((max, atMs, index) => index ? Math.max(max, atMs - boundaries[index - 1]) : max, 0);
};
const overallOk = !runtimeGateError && durationOk && turnsOk && anchorsOk && isolationOk && rolloverOk && receiptsOk && ttsPartsOk
  && streamContinuityOk && restartsOk
  && visualIdentityOk && primerAuthorizationOk && dialogueStyleOk && cleanupOk;

const transcript = turns.map((turn) => {
  const anchors = Array.isArray(turn.anchorEventIds) && turn.anchorEventIds.length ? turn.anchorEventIds.join(", ") : "无";
  const anchorEvidence = (Array.isArray(turn.anchorEventIds) ? turn.anchorEventIds : [])
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .map((event) => `[${event.id}; ${event.kind}] ${event.text}`)
    .join("\n") || "无";
  const receipt = turn.ttsReceipt || null;
  return `### 第 ${turn.index} 轮 · ${elapsed(turn.startedAtMs)} · ${turn.maturity || turn.category || "未分类"}

- 计划时刻：${elapsed(turn.scheduledAtMs)}
- 调度滞后：${number(turn.scheduleLagMs)} ms
- 回复及播音耗时：${number(turn.responseMs)} ms
- 证据锚点：${anchors}
- 锚点原文：${anchorEvidence}
- TTS：${receiptState(receipt)}；首音频 ${receiptMetric(receipt, ["firstAudioMs", "ttfaMs", "timeToFirstAudioMs"])} ms；总计 ${receiptMetric(receipt, ["totalMs", "durationMs", "completedMs"])} ms
- 状态：${turn.ok ? "成功" : `失败（${turn.error || "未知错误"}）`}

**用户**

${turn.prompt || "（无问题）"}

**元元**

${turn.assistant || "（无回复）"}
`;
}).join("\n");
const proactiveTranscript = discussion.map((turn) => `### ${elapsed(number(turn.atMs) - number(report.startedAtMs))} · ${turn.role === "user" ? "用户" : "元元"}

${String(turn.content || "").trim()}
`).join("\n");

const markdown = `# 共同体验 30 分钟压力测试报告

> 自动验收结论：**${overallOk ? "通过" : "不通过"}**。本结论只按结构化门槛计算；内容准确性仍需结合下方完整记录人工审阅。

## 测试范围

- 实测时段：${localTime(report.startedAtMs)} 至 ${localTime(report.endedAtMs)}（Asia/Shanghai）。
- 实际持续：${seconds(report.durationMs)}；计划 ${seconds(report.plannedDurationMs)}。
- 运行版本：\`${report.environment?.buildKind || "unknown"}\`，可执行文件 \`${report.environment?.executable || "未记录"}\`。
- 观察目标：窗口 \`${report.environment?.selectedWindowId ?? "未记录"}\`，\`${report.environment?.selectedWindow || "未记录"}\`。
- 模型链路：Mage-VL + ${report.environment?.asrProvider || "SenseVoice2"} + ${report.environment?.textProvider || "DeepSeek"} \`${report.environment?.textModel || "未记录"}\` + ${report.environment?.voiceBackend || "VoxCPM2"}。
- 原始数据：\`${path.relative(rootDir, rawPath)}\`。

## 门槛结果

| 门槛 | 实际 | 判定 |
| --- | --- | --- |
| 运行回执、素材与总结统一校验 | ${runtimeGateError || "真实链路、素材零丢弃、总结入库已验证"} | ${runtimeGateError ? "不通过" : "通过"} |
| 真实持续不少于 30 分钟 | ${seconds(report.durationMs)} | ${durationOk ? "通过" : "不通过"} |
| ${proactiveOnly ? "主动发言完成" : "30 分钟内已完成轮次全部成功"} | ${proactiveOnly ? `${number(proactive.totals?.completed)} 次` : `${number(report.successfulTurns)}/${turns.length} 完成，计划 ${number(report.plannedTurns)}，deadline 跳过 ${number(report.skippedTurns)}`} | ${turnsOk ? "通过" : "不通过"} |
| 每轮动态问题均有可解析证据锚点 | ${proactiveOnly ? "不适用（零预设问题）" : `${anchoredTurns.length}/${turns.length}`} | ${anchorsOk ? "通过" : "不通过"} |
| 锚点来源 | ${inlineCounts(anchorKinds)} | 记录 |
| 问题成熟度演进 | ${inlineCounts(maturities)} | 记录 |
| 30 分钟 rollover | segmentId=${finalSegmentId}；segment summary=${segmentSummaryRequests} | ${rolloverOk ? "通过" : "不通过"} |
| dev/安装版隔离 | ${number(isolation.checks)} 次检查；${isolationViolations.length} 次违规 | ${isolationOk ? "通过" : "不通过"} |
| ${proactiveOnly ? "主动发言 TTS 回执" : "每个已完成轮次都有 TTS 回执"} | ${proactiveOnly ? `完成=${number(proactive.totals?.completed)}；失败=${number(proactive.totals?.ttsFailed)}；部分=${number(proactive.totals?.ttsPartial)}` : inlineCounts(receiptCounts)} | ${receiptsOk ? "通过" : "不通过"} |
| VoxCPM2 admission/完成闭环 | ${proactiveOnly ? `主动完成=${number(proactive.totals?.completed)}；不完整=${number(proactive.totals?.ttsIncomplete)}` : `requested=${ttsParts.requestedParts}；admitted=${ttsParts.admittedParts}；started=${ttsParts.startedParts}；completed=${ttsParts.completedParts}；failed=${ttsParts.failedParts}`} | ${ttsPartsOk ? "通过" : "不通过"} |
| VoxCPM2 流式连续性 | ${proactiveOnly ? `主动不完整=${number(proactive.totals?.ttsIncomplete)}` : `underrun=${underrunCounts.reduce((sum, value) => sum + value, 0)}；maxGap=${Math.max(0, ...streamGapValues)} ms`} | ${streamContinuityOk ? "通过" : "不通过"} |
| VoxCPM2 非预期重启 | ${number(voice.unexpectedRestarts)} 次；失败 ${number(voice.failures)} 次 | ${restartsOk ? "通过" : "不通过"} |
| 停止后媒体与工作区释放 | capture=${cleanup.captureStopped === true}；spool=${cleanup.spoolReleased === true}；workspace=${cleanup.workspaceReleased === true}；pending=${number(cleanup.pending)} | ${cleanupOk ? "通过" : "不通过"} |
| 视觉身份猜测漏入 Evidence | ${visualIdentityLeaks.length} 条 | ${visualIdentityOk ? "通过" : "不通过"} |
| Tavily Primer 显式用户授权 | ${viewingStatement ? `已解析：${viewingStatement.title}（${viewingStatement.format}）` : "无显式声明"}；gate=${primerGateStatus}；Primer ${primerEvents.length} 条 | ${primerAuthorizationOk ? "通过" : "不通过"} |
| 陪看回复无审计口吻 | ${auditStyleTurns.length ? JSON.stringify(auditStyleTurns) : "0 条命中"} | ${dialogueStyleOk ? "通过" : "不通过"} |

## 性能与资源

| 指标 | 结果 |
| --- | --- |
| 回复及播音耗时 | 平均 ${seconds(average(responseTimes))}；P50 ${seconds(percentile(responseTimes, 0.5))}；P95 ${seconds(percentile(responseTimes, 0.95))}；最大 ${seconds(Math.max(0, ...responseTimes))} |
| 调度滞后 | P50 ${number(percentile(scheduleLags, 0.5))} ms；P95 ${number(percentile(scheduleLags, 0.95))} ms；最大 ${number(Math.max(0, ...scheduleLags))} ms |
| TTS 首音频 | ${ttfaValues.length} 轮有值；平均 ${seconds(average(ttfaValues))}；P95 ${seconds(percentile(ttfaValues, 0.95))} |
| TTS 总耗时 | ${ttsTotalValues.length} 轮有值；平均 ${seconds(average(ttsTotalValues))}；P95 ${seconds(percentile(ttsTotalValues, 0.95))} |
| TTS admission/播放分段 | requested=${ttsParts.requestedParts}；admitted=${ttsParts.admittedParts}；started=${ttsParts.startedParts}；completed=${ttsParts.completedParts}；failed=${ttsParts.failedParts} |
| TTS 流式断流 | 总 underrun ${underrunCounts.reduce((sum, value) => sum + value, 0)}；单轮最大 gap ${Math.max(0, ...streamGapValues)} ms |
| 画面采集/处理 | ${number(workspace.capturedVisual)} / ${number(workspace.processedVisual)} |
| 画面逐分钟采集覆盖 | ${captureMinutes("visual")}/30 分钟 |
| 画面最大采集间隔（含首尾） | ${maxCaptureGapMs("visual")} ms；门槛 15000 ms |
| 视觉身份猜测过滤 | ${number(workspace.filteredVisualIdentities)} 条 |
| 匿名人物轨迹 | ${number(workspace.characters)} 条 |
| 音频采集/处理 | ${number(workspace.capturedAudio)} / ${number(workspace.processedAudio)} |
| 音频逐分钟采集覆盖 | ${captureMinutes("audio")}/30 分钟 |
| 音频最大采集间隔（含首尾） | ${maxCaptureGapMs("audio")} ms；门槛 30000 ms |
| 推理积压峰值 | ${number(workspace.peakPending)} 条；${number(workspace.peakBytes)} bytes |
| 截止瞬间媒体积压 | ${number(workspace.pending)} 条；${number(workspace.bytes)} bytes |
| spool 丢弃 | ${number(workspace.dropped)} 条；${JSON.stringify(workspace.droppedByKind || {})} |
| 停止后媒体积压 | ${number(cleanup.pending)} |
| Evidence Journal | ${evidence.length} 条；${inlineCounts(evidenceKinds)} |
| Evidence blocks | ${blocks.length} 个 |
| Content Primer | ${primerEvents.length ? `已建立 ${primerEvents.length} 条会话级参考` : "未建立或失败关闭"} |

## DeepSeek 用量与费用

- 对话：${usageLine(usage.conversation)}。
- 证据压缩：${usageLine(usage.evidenceSummary)}。
- 分段总结：${usageLine(usage.segmentSummary)}。
- 最终总结：${usageLine(usage.finalSummary)}。
- 估算费用：$${number(budget.estimatedCostUsd).toFixed(8)} / $${number(budget.limitUsd).toFixed(2)}；budget exhausted=${Boolean(budget.exhausted)}。
${number(budget.estimatedCostUsd) > 0 ? "" : "- 估算未确认，不能据此认定免费；可能没有用量、未匹配价格或缺少记录。以账户余额差辅助核对，余额差也可能含其它请求。\n"}
- 账户余额：${balance.currency || "未记录"} ${balance.starting ?? "未记录"} -> ${balance.current ?? "未记录"}，变化 ${balance.delta ?? "未记录"}。

## 隔离、Rollover 与收尾

- 隔离违规：${isolationViolations.length ? JSON.stringify(isolationViolations) : "无"}。
- 跳过的计划槽位：${skippedTurnDetails.length ? JSON.stringify(skippedTurnDetails) : `${number(report.skippedTurns)} 个（均因 deadline，未记录更细原因）`}。
- rollover：finalize 后 segmentId=${finalSegmentId}，结束前 rollingSummary=${String(workspace.rollingSummary || "").length} 字，段总结请求 ${segmentSummaryRequests} 次。
- VoxCPM2：runningSeen=${Boolean(voice.runningSeen)}，failures=${number(voice.failures)}，unexpectedRestarts=${number(voice.unexpectedRestarts)}。
- finalize：${JSON.stringify(report.finalize ?? null)}。
- finalize error：${report.finalizeError || "无"}。

## 内容质量人工审阅清单

- 开场是否只陈述浅层事实，没有在证据稀少时补全剧情。
- 每轮回答是否与记录的 evidence anchor 相关，且 ASR 剧情信息得到充分使用。
- 事实、用户确认、角色推断是否清楚分层；新证据冲突时是否撤销旧假设。
- 后期是否形成跨时间、有依据的剧情与人物讨论，而非只描述当前帧。
- Mage-VL 猜测的作品名或角色名是否污染回答、阶段总结或最终 Memory。
- Content Primer 是否只用于身份校正和无剧透基础设定，没有把未播放剧情当作已观察事实。
- 回复是否直接讨论内容，没有反复使用“这句是”“具体还没揭晓”或强行比较声画的审计口吻。
- 普通电影人物是否保持匿名/暂定/已确认层级，没有仅凭单帧外观把不同人物合并。

## 最终 Memory 总结

> ${String(report.finalize?.summary || "（没有生成总结）").replaceAll("\n", " ")}

存储状态：stored=${Boolean(report.finalize?.stored)}，duplicate=${Boolean(report.finalize?.duplicate)}，reason=${report.finalize?.reason || "无"}。

## ${proactiveOnly ? "主动陪看最近对话记录（最多 256 条）" : `完整 ${turns.length} 轮对话记录`}

以下内容逐字来自 raw JSON；时间为相对测试开始时间。${proactiveOnly ? "讨论日志仅保留最近 256 条，超过上限的早期发言不在此快照中。" : ""}

${proactiveOnly ? proactiveTranscript || "（验收快照没有讨论日志）" : transcript}`;

await writeFile(reportPath, markdown, "utf8");
console.log(`wrote ${path.relative(rootDir, reportPath)} (${turns.length} turns, ${overallOk ? "PASS" : "FAIL"})`);
