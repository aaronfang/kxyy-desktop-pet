import { readFile, writeFile } from "node:fs/promises";
import { requestGroundedReplyRepair } from "../../src/ai/shared-experience-grounding.js";

const [apiBase,input,output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: repair-replay.mjs loopback-api input.json output.json");
}
const report=JSON.parse(await readFile(input,"utf8"));
const records=[];
for (const turn of report.turns.filter((turn)=>turn.groundingAudit?.accepted === false)) {
  const calls=[], usage=[];
  const started=performance.now();
  const result=await requestGroundedReplyRepair({apiBase,question:turn.prompt,evidence:turn.groundingAudit.evidence,botName:"元元",
    onUsage:(value,model,kind)=>usage.push({kind,model,...value}),
    fetchImpl:async(...args)=>{
      const response=await fetch(...args);
      const data=await response.clone().json();
      calls.push({status:response.status,content:data.choices?.[0]?.message?.content,finishReason:data.choices?.[0]?.finish_reason});
      return response;
    },
  });
  records.push({index:turn.index,question:turn.prompt,original:turn.groundingAudit.draft,result,calls,usage,
    evidence:turn.groundingAudit.evidence,latencyMs:Math.round(performance.now()-started)});
  console.log(`Turn ${turn.index}: ${result?.text || "rejected"}`);
}
await writeFile(output,JSON.stringify({scope:"Bounded repair replay on unchanged contemporaneous evidence. No new media, playback or Memory; not app E2E.",records},null,2),{flag:"wx"});
