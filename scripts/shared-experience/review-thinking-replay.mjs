import { readFile, writeFile } from "node:fs/promises";
import { requestGroundingReview } from "../../src/ai/shared-experience-grounding.js";

const [apiBase, input, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase || "") || !input || !output) {
  throw new Error("Usage: review-thinking-replay.mjs loopback-api report.json output.json");
}
const journal = JSON.parse(await readFile(input,"utf8")).beforeFinalize.workspace.evidenceJournal;
const cases = [
  {text:"使用医疗包后完全没有作用。",id:"ev-28",accept:false},
  {text:"解说觉得扎针后好像没起什么作用。",id:"ev-28",accept:true},
  {text:"女孩已经被营救出来。",id:"ev-95",accept:false},
  {text:"对白提到女孩被带去审讯。",id:"ev-95",accept:true},
  {text:"已关掉电闸并找到了安娜。",id:"ev-103",accept:false},
  {text:"解说提到可以潜行寻找安娜。",id:"ev-103",accept:true},
];
const evidence = journal.filter((event)=>cases.some((item)=>item.id === event.id));
const records = [];
for (const thinking of [false,true]) {
  let providerOutput,usage,model;
  const startedAtMs = Date.now();
  const result = await requestGroundingReview({apiBase,kind:"summary",text:cases.map((item)=>item.text).join("\n"),
    evidence,claimSources:cases.map((item)=>[item.id]),claimTypes:cases.map(()=>"speech"),
    onUsage:(u,m)=>{usage=u;model=m;},
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);
      body.thinking=thinking;
      const response=await fetch(url,{...init,body:JSON.stringify(body)});
      const data=await response.clone().json();
      providerOutput={content:data.choices?.[0]?.message?.content,finishReason:data.choices?.[0]?.finish_reason,
        usage:data.usage};
      return response;
    }});
  const passed = result?.parts.filter((part,index)=>(part.verdict === "supported") === cases[index].accept).length || 0;
  records.push({thinking,startedAtMs,latencyMs:Date.now()-startedAtMs,passed,total:cases.length,result,usage,model,providerOutput});
  console.log(`${thinking ? "thinking" : "baseline"}: ${passed}/${cases.length}`);
}
await writeFile(output,JSON.stringify({scope:"Fixed positive/negative factual pairs from original ASR, same reviewer protocol. No generation, playback or Memory.",cases,evidence,records},null,2),{flag:"wx"});
