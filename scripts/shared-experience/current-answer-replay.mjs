import { readFile, writeFile } from "node:fs/promises";
import { createSharedExperienceWorkspace } from "../../src/ai/shared-experience-workspace.js";
import { groundingEvidence, requestGroundingReview } from "../../src/ai/shared-experience-grounding.js";

const [apiBase, input, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: current-answer-replay.mjs loopback-api report.json output.json");
}
const report = JSON.parse(await readFile(input, "utf8"));
const records = [];
// A bounded current-answer probe, not a reconstruction of persona, trackers or app playback.
for (const turn of report.turns.slice(0, 3)) {
  const now = report.startedAtMs + turn.startedAtMs;
  const workspace = createSharedExperienceWorkspace({ nowMs: () => now, contentMode: "narrated" });
  for (const source of turn.groundingAudit.evidence) {
    if (!Number.isFinite(source.ageMs)) continue;
    if (source.kind === "visual") workspace.addVisualObservation({ summary: source.text, capturedAtMs: now - source.ageMs });
    if (source.kind === "audio") workspace.addAudioObservation({ text: source.text, startedAtMs: now - source.ageMs });
  }
  const started = performance.now();
  const response = await fetch(`${apiBase}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ provider: "text", stream: false, thinking: false, temperature: 0, max_tokens: 180,
      messages: [{ role: "system", content: workspace.renderPrompt({ question: turn.prompt }) },
        { role: "user", content: turn.prompt }] }),
  });
  if (!response.ok) throw new Error(`Generation HTTP ${response.status}`);
  const data = await response.json();
  const draft = data.choices?.[0]?.message?.content || "";
  const evidence = groundingEvidence(workspace.snapshot(), { nowMs: now });
  let reviewUsage, reviewOutput;
  const result = data.choices?.[0]?.finish_reason === "length" ? null : await requestGroundingReview({
    apiBase, kind: "reply", question: turn.prompt, text: draft, evidence,
    onUsage: (usage) => { reviewUsage = usage; },
    fetchImpl: async (...args) => {
      const response = await fetch(...args);
      const data = await response.clone().json();
      reviewOutput = data.choices?.[0]?.message?.content;
      return response;
    },
  });
  records.push({ index: turn.index, question: turn.prompt, draft, result, evidence, reviewOutput,
    generationUsage: data.usage, reviewUsage, model: data.model, latencyMs: Math.round(performance.now() - started) });
  console.log(`Turn ${turn.index}: ${result?.text || "rejected"}`);
}
await writeFile(output, JSON.stringify({
  scope: "First three unchanged questions with their contemporaneous raw evidence; production workspace prompt and review. No persona, prior discussion, evidence blocks, character tracker, capture, TTS or Memory. Not app E2E.",
  records,
}, null, 2), { flag: "wx" });
