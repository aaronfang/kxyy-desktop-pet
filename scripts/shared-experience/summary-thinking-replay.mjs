import { readFile, writeFile } from "node:fs/promises";
import { requestSharedExperienceSummary } from "../../src/ai/shared-experience-client.js";

const [apiBase, input, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: summary-thinking-replay.mjs loopback-api report.json output.json");
}
const prior = JSON.parse(await readFile(input, "utf8")).beforeFinalize.workspace;
const evidence = prior.evidenceJournal.filter((event) => ["visual", "audio"].includes(event.kind));
const records = [];
for (const thinking of [false, true]) {
  const startedAtMs = Date.now();
  const providerOutputs = [];
  let calls = 0;
  try {
    const result = await requestSharedExperienceSummary({ apiBase, kind: "final", evidence, timeoutMs: 45000,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (++calls === 1 && thinking) {
          body.thinking = true;
          body.max_tokens = 4096;
        }
        const response = await fetch(url, {...init,body:JSON.stringify(body)});
        const data = await response.clone().json();
        providerOutputs.push({stage:calls === 1 ? "generation" : "review",thinking:body.thinking,
          maxTokens:body.max_tokens,content:data.choices?.[0]?.message?.content,
          finishReason:data.choices?.[0]?.finish_reason,usage:data.usage});
        return response;
      },
    });
    records.push({thinking,startedAtMs,latencyMs:Date.now()-startedAtMs,providerOutputs,...result});
    console.log(`${thinking ? "thinking" : "baseline"}: ${result.summary}`);
  } catch (error) {
    records.push({thinking,startedAtMs,latencyMs:Date.now()-startedAtMs,providerOutputs,
      error:"summary-rejected",...error?.summaryUsage});
    console.log(`${thinking ? "thinking" : "baseline"}: rejected`);
  }
}
await writeFile(output,JSON.stringify({scope:"Same original media, generation-only thinking experiment. No playback or Memory writes.",evidence,records},null,2),{flag:"wx"});
