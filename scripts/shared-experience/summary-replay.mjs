import { readFile, writeFile } from "node:fs/promises";
import { requestSharedExperienceSummary } from "../../src/ai/shared-experience-client.js";

const [apiBase, input, output, mode] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: summary-replay.mjs loopback-api existing-report.json output.json");
}
const prior = JSON.parse(await readFile(input, "utf8")).beforeFinalize.workspace;
const records = [];
const batches = mode === "--final"
  ? [{id:"final",eventIds:prior.evidenceJournal.filter((event)=>["visual","audio"].includes(event.kind)).map((event)=>event.id),
    summary:prior.evidenceBlocks.map((block)=>`[${block.id}] ${block.summary}`).join("\n")}]
  : prior.evidenceBlocks;
for (const block of batches) {
  const evidence = prior.evidenceJournal.filter((event) => block.eventIds.includes(event.id));
  const compactedIds = new Set(prior.evidenceBlocks.flatMap((item)=>item.eventIds));
  const source = mode === "--final" ? `${block.summary}\n${evidence.filter((event)=>!compactedIds.has(event.id))
    .map((event)=>`[${event.id}] ${event.kind}: ${event.text}`).join("\n")}` : "";
  const started = performance.now();
  const providerOutputs = [];
  try {
    const result = await requestSharedExperienceSummary({ apiBase, kind: mode === "--final" ? "final" : "evidence", source, evidence,
      fetchImpl: async (...args) => {
        const response = await fetch(...args);
        const data = await response.clone().json();
        providerOutputs.push({ content: data.choices?.[0]?.message?.content, finishReason: data.choices?.[0]?.finish_reason });
        return response;
      },
    });
    records.push({ id: block.id, evidence, previous: block.summary, providerOutputs, ...result, latencyMs: Math.round(performance.now() - started) });
    console.log(`${block.id}: ${evidence.length} sources, ${result.summary.length} summary chars\n${result.summary}`);
  } catch (error) {
    records.push({ id: block.id, evidence, error: "summary-rejected", providerOutputs, ...error?.summaryUsage,
      latencyMs: Math.round(performance.now() - started) });
    console.log(`${block.id}: rejected`);
  }
}
await writeFile(output, JSON.stringify({ records }, null, 2), { flag: "wx" });
if (records.some((record) => record.error)) process.exitCode = 1;
