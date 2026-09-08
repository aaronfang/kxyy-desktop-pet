import { writeFile } from "node:fs/promises";
import { requestGroundingReview } from "../../src/ai/shared-experience-grounding.js";

const [apiBase,output]=process.argv.slice(2);
if (!apiBase || !output) throw new Error("Usage: grounding-replay.mjs loopback-api report.json");
const cases=[
  {name:"mask-causality",kind:"reply",question:"他们要求还什么？",text:"他们要求把面罩还回去。这些人被抢了装备才翻脸的。",
    evidence:[{id:"a",kind:"audio",text:"At least give them the masks back."}],required:"面罩",forbidden:"翻脸"},
  {name:"latest-departure",kind:"reply",question:"他们现在出发了吗？",text:"应该不是马上出发，还有伤员要处理，得先把人安顿好才上路吧。",
    evidence:[{id:"a",kind:"audio",text:"So many wounded."},{id:"b",kind:"audio",text:"好了，现在我们直接起身去寻找我们的队。"}],reject:true},
  {name:"future-question",kind:"question",text:"等她走过来之后具体会发生什么动作？",
    evidence:[{id:"a",kind:"audio",text:"我们在这里还是要等她走过来才能触发接下来的剧情。"}],reject:true},
  {name:"grounded-question",kind:"question",text:"他们要求把什么还给那些人？",
    evidence:[{id:"a",kind:"audio",text:"At least give them the masks back."}],required:"什么"},
  {name:"visible-condition",kind:"question",text:"他手里的金属杆看起来是什么状态？",
    evidence:[{id:"v",kind:"visual",text:"视频中显示一只手握着一根生锈的金属杆，背景是昏暗的工业环境。"}],required:"金属杆"},
  {name:"unknown-tool-use",kind:"question",text:"他手里的金属杆要用来撬开什么？",
    evidence:[{id:"v",kind:"visual",text:"视频中显示一只手握着一根生锈的金属杆，背景是昏暗的工业环境。"}],reject:true},
  {name:"watching-acknowledgment",kind:"reply",question:"我们在看游戏解说视频",text:"好呀，一起看吧。",evidence:[],required:"一起看"},
  {name:"prediction-not-social",kind:"reply",question:"你觉得他接下来会做什么？",text:"我觉得他接下来会用金属杆杀死守卫。",
    evidence:[{id:"v",kind:"visual",text:"一只手握着一根生锈的金属杆。"}],reject:true},
];
const records=[];
for (const item of cases) {
  const started=performance.now(); let usage,model;
  const result=await requestGroundingReview({...item,apiBase,onUsage:(u,m)=>{usage=u;model=m;}});
  const pass=item.reject ? result===null : Boolean(result?.text.includes(item.required) && (!item.forbidden || !result.text.includes(item.forbidden)));
  records.push({...item,result,pass,latencyMs:Math.round(performance.now()-started),usage,model});
  console.log(`${item.name}: ${pass?"PASS":"FAIL"} ${result?.text||"rejected"}`);
}
await writeFile(output,JSON.stringify({records},null,2),{flag:"wx"});
if (records.some((record)=>!record.pass)) process.exitCode=1;
