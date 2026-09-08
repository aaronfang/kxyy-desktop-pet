import { readFile, writeFile } from "node:fs/promises";
import { groundingEvidence, requestGroundingReview } from "../../src/ai/shared-experience-grounding.js";

const [apiBase, input, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: quality-regression-replay.mjs loopback-api prior-report.json output.json");
}
const report = JSON.parse(await readFile(input, "utf8"));
const journal = report.beforeFinalize.workspace.evidenceJournal;
const blocks = report.beforeFinalize.workspace.evidenceBlocks;
const cases = [
  { index: 1, name: "old-outdoor-current-place", accept: false },
  { index: 2, name: "recent-audio-with-uncertainty", accept: true },
  { index: 4, name: "old-fire-current-operation", accept: false },
  { index: 6, name: "comparison-retains-history", accept: true },
].map((item) => {
  const turn = report.turns.find((turn) => turn.index === item.index);
  const ids = new Set(turn.groundingAudit.evidence.map((event) => event.id));
  blocks.filter((block) => ids.has(block.id)).forEach((block) => block.eventIds.forEach((id) => ids.add(id)));
  const evidence = groundingEvidence({ evidenceJournal: journal.filter((event) => ids.has(event.id)),
    evidenceBlocks: blocks.filter((block) => ids.has(block.id)) }, { nowMs: report.startedAtMs + turn.startedAtMs });
  return { ...item, question: turn.prompt, text: turn.groundingAudit.draft, evidence };
});
cases.push(
  { name: "current-room-positive", accept: true, question: "现在是什么画面？", text: "穿深色毛衣的人坐在房间里，后面有书架和杂物。",
    evidence: [{ id: "ev-50", kind: "visual", ageMs: 1000, scope: "current", text: journal.find((event) => event.id === "ev-50").text }] },
  { name: "promise-speaker-inversion", accept: false, question: "这句话里是谁承诺？", text: "老者承诺这是最后一次。",
    evidence: [{ id: "ev-90", kind: "audio", text: journal.find((event) => event.id === "ev-90").text }] },
  { name: "promise-request-positive", accept: true, question: "这句话是在要求什么？", text: "说话的人在要求对方保证这是最后一次。",
    evidence: [{ id: "ev-90", kind: "audio", text: journal.find((event) => event.id === "ev-90").text }] },
);
const records = [];
for (const item of cases) {
  const started = performance.now();
  let usage, model, providerOutput;
  const result = await requestGroundingReview({ ...item, apiBase, kind: "reply", onUsage: (u, m) => { usage = u; model = m; },
    fetchImpl: async (...args) => {
      const response = await fetch(...args);
      const data = await response.clone().json();
      providerOutput = { content: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason };
      return response;
    },
  });
  const pass = Boolean(result) === item.accept;
  records.push({ ...item, result, pass, usage, model, providerOutput, latencyMs: Math.round(performance.now() - started) });
  console.log(`${item.name}: ${pass ? "PASS" : "FAIL"} ${result?.text || "rejected"}`);
}
await writeFile(output, JSON.stringify({ records }, null, 2), { flag: "wx" });
if (records.some((record) => !record.pass)) process.exitCode = 1;
