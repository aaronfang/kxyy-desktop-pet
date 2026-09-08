import test from "node:test";
import assert from "node:assert/strict";
import { applyGroundingReview, requestGroundingReview, groundingEvidence, requestGroundedReplyRepair } from "../src/ai/shared-experience-grounding.js";

const evidence = [{id:"a",kind:"audio",text:"At least give them the masks back."}];
const good = "他们要求把面罩还回去。";
const bad = "这些人被抢了装备才翻脸的。";
const part = {text:good, verdict:"supported", supports:[{id:"a",quote:"give them the masks back"}]};

test("review binds verdicts to caller-owned whole sentences instead of provider comma splits", async () => {
  const text="他们要求把面罩还回去，其他打算还没听清。";
  let submitted;
  const result=await requestGroundingReview({apiBase:"http://127.0.0.1:1234",kind:"reply",text,evidence,
    fetchImpl:async(_url,init)=>{
      submitted=JSON.parse(JSON.parse(init.body).messages[1].content);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({parts:[{index:0,verdict:"supported",supports:part.supports}]})}}]})};
    },
  });
  assert.equal(result?.text,text);
  assert.deepEqual(submitted.sentences,[{index:0,text}]);
});

test("indexed review rejects missing, duplicate, reordered and rewritten sentences", async () => {
  const text="他们要求归还面罩。我还没看清。";
  const valid=[{index:0,verdict:"supported",supports:part.supports},{index:1,verdict:"nonfactual",supports:[]}];
  for (const parts of [[valid[0]],[valid[0],valid[0]],[valid[1],valid[0]],
    [{...valid[0],text:"已经归还面罩。"},valid[1]]]) {
    const result=await requestGroundingReview({apiBase:"http://127.0.0.1:1234",kind:"reply",text,evidence,
      fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({parts})}}]})}),
    });
    assert.equal(result,null);
  }
});

test("a rejected answer can be rebuilt once from the same evidence and reviewed before use", async () => {
  const calls = [];
  const usage = [];
  const text = "已经到营地了。";
  const evidence = [{id:"a",kind:"audio",text:"好了，现在我们通过这处管道来到了营地。",scope:"current",ageMs:1000}];
  const result = await requestGroundedReplyRepair({apiBase:"http://127.0.0.1:1234",question:"他现在在哪里？",evidence,
    onUsage:(u,m,kind)=>usage.push({u,m,kind}),
    fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body); calls.push(body);
      assert.doesNotMatch(JSON.stringify(body),/正在往营地去/);
      assert.doesNotMatch(JSON.stringify(body),/医疗|赶路/);
      const content = calls.length === 1 ? text : JSON.stringify({parts:[{text,verdict:"supported",supports:[{id:"a",quote:"来到了营地"}]}]});
      return {ok:true,json:async()=>({model:"deepseek-v4-flash",usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:"stop",message:{content}}]})};
    },
  });
  assert.equal(result?.draft,text);
  assert.equal(calls.length,2);
  assert.deepEqual(usage.map(item=>item.kind),["conversation","groundingReview"]);
});

test("a clear observation eight seconds ago remains current when two newer frames omit the object", () => {
  const sources=groundingEvidence({evidenceJournal:[
    {id:"gun",kind:"visual",atMs:52000,text:"玩家手持枪械向前走。"},
    {id:"scene-1",kind:"visual",atMs:56000,text:"雪地废墟。"},
    {id:"scene-2",kind:"visual",atMs:59000,text:"身边是破旧车辆。"},
  ]},{nowMs:60000});
  assert.equal(sources[0].scope,"current");
  const result=applyGroundingReview({kind:"reply",question:"现在手里拿着什么？",text:"枪。",evidence:sources,
    review:{parts:[{text:"枪。",verdict:"supported",supports:[{id:"gun",quote:"手持枪械"}]}]}});
  assert.equal(result?.text,"枪。");
});

test("repair never emits a rejected draft, retries repeatedly or spends after cancellation", async () => {
  for (const scenario of ["rejected", "stale", "budget", "length", "network", "timeout"]) {
    let calls=0, current=true, spend=true;
    const result=await requestGroundedReplyRepair({apiBase:"http://127.0.0.1:1234",question:"他们现在在哪？",evidence,
      isCurrent:()=>current,canSpend:()=>spend,timeoutMs:scenario === "timeout" ? 5 : 12000,
      fetchImpl:async(_url,init)=>{
        calls++;
        if (scenario === "network") throw new Error("offline");
        if (scenario === "timeout") return new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("timeout"))));
        if (scenario === "stale") current=false;
        if (scenario === "budget") spend=false;
        return {ok:true,json:async()=>({choices:[{finish_reason:scenario === "length" ? "length" : "stop",message:{
          content:calls === 1 ? "他们已经回家了。" : JSON.stringify({parts:[{text:"他们已经回家了。",verdict:"unsupported",supports:[]}]}),
        }}]})};
      },
    });
    assert.equal(result,null,scenario);
    assert.equal(calls,scenario === "rejected" ? 2 : 1,scenario);
  }
  const controller=new AbortController();controller.abort();
  assert.equal(await requestGroundedReplyRepair({apiBase:"http://127.0.0.1:1234",question:"在哪？",signal:controller.signal,
    fetchImpl:async()=>assert.fail("cancelled repair sent a request")}),null);
});

test("current-state review preserves evidence age and cannot rely only on an earlier scene", async () => {
  const sources = groundingEvidence({ evidenceJournal: [
    { id: "old", kind: "visual", atMs: 1000, text: "室外的废墟和火焰。" },
    { id: "new", kind: "visual", atMs: 59000, text: "室内，一位老人站在桌旁。" },
  ] }, { nowMs: 60000 });
  assert.equal(sources[0].ageMs, 59000);
  assert.equal(sources[0].scope, "history");
  assert.equal(sources[1].scope, "current");
  assert.equal(sources[1].ageMs, 1000);
  const text = "他们还在室外废墟。";
  const review = { parts: [{ text, verdict: "supported", supports: [{ id: "old", quote: "室外的废墟和火焰" }] }] };
  const fetchImpl = async (_url, init) => {
    const sent = JSON.parse(JSON.parse(init.body).messages[1].content).sources;
    assert.equal(sent[0].ageMs, 59000);
    assert.equal(sent[0].scope, "history");
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(review) } }] }) };
  };
  assert.equal(await requestGroundingReview({ apiBase: "http://127.0.0.1:1234", kind: "reply", question: "现在这个地方是室内还是室外？", text, evidence: sources, fetchImpl }), null);
  assert.equal(applyGroundingReview({ kind: "reply", question: "刚开始是在什么地方？", text, evidence: sources, review })?.text, text);
  const currentText = "现在在室内，老人站在桌旁。";
  const currentReview = { parts: [{ text: currentText, verdict: "supported", supports: [{ id: "new", quote: "室内，一位老人站在桌旁。" }] }] };
  assert.equal(applyGroundingReview({ kind: "reply", question: "现在在哪？", text: currentText, evidence: sources, review: currentReview })?.text, currentText);
  const stale = groundingEvidence({ evidenceJournal: [{ id: "new", kind: "visual", atMs: 59000, text: "室内，一位老人站在桌旁。" }] }, { nowMs: 120000 });
  assert.equal(stale[0].scope, "history");
  assert.equal(applyGroundingReview({ kind: "reply", question: "现在在哪？", text: currentText, evidence: stale, review: currentReview }), null);
});

test("recalling recently heard speech can use historical audio without asserting it is still happening", () => {
  const sources = [
    {id:"a",kind:"audio",text:"用它回上一口血。",scope:"history",ageMs:30000},
    {id:"b",kind:"visual",text:"昏暗的通道。",scope:"current",ageMs:1000},
  ];
  const text = "刚才说用它回口血。";
  const review = {parts:[{text,verdict:"supported",supports:[{id:"a",quote:"用它回上一口血"}]}]};
  for (const question of ["刚刚解说提到要做什么？我漏听了一点。","刚才说了什么？"]) {
    assert.equal(applyGroundingReview({kind:"reply",question,text,evidence:sources,review})?.text,text);
  }
  assert.equal(applyGroundingReview({kind:"reply",question:"现在在做什么？",text,evidence:sources,review}),null);
});

test("a review can retain the grounded answer but cannot forward invented causality", () => {
  const result = applyGroundingReview({kind:"reply",text:good+bad,evidence,
    review:{parts:[part,{text:bad,verdict:"unsupported",supports:[]}]}});
  assert.equal(result.text, good);
  assert.equal(result.removedParts, 1);
});

test("review resolves original source ids inside a summary without borrowing another source quote", () => {
  const text = "一开始他们失血过多，后来被抬回营地。";
  const summary = { id: "block-1", kind: "summary", text: "[ev-9] 我们失血过多，即将昏迷了。[ev-15] 被同伴抬回营地。",
    references: [{ id: "ev-9", text: "我们失血过多，即将昏迷了。" }, { id: "ev-15", text: "被同伴抬回营地。" }] };
  const review = { parts: [{ text, verdict: "supported", supports: [
    { id: "ev-9", quote: "我们失血过多，即将昏迷了。" }, { id: "ev-15", quote: "被同伴抬回营地。" },
  ] }] };
  assert.equal(applyGroundingReview({ kind: "reply", text, evidence: [summary], review })?.text, text);
  review.parts[0].supports[0].quote = "被同伴抬回营地。";
  assert.equal(applyGroundingReview({ kind: "reply", text, evidence: [summary], review }), null);
});

test("a compacted source outside the recent window remains resolvable through the request boundary", async () => {
  const sources = groundingEvidence({
    evidenceBlocks: [{ id: "block-1", summary: "有人要求归还面罩（原文：[a] At least give them the masks back.）", eventIds: ["a"], endedAtMs: 1000 }],
    evidenceJournal: [{ id: "a", kind: "audio", text: "At least give them the masks back.", atMs: 1000 },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `v-${index}`, kind: "visual", text: "室内场景。", atMs: 2000 + index * 1000 }))],
  }, { nowMs: 26000 });
  assert.equal(sources.some((source) => source.id === "a"), false);
  assert.equal(sources[0].references[0].id, "a");
  const result = await requestGroundingReview({ apiBase: "http://127.0.0.1:1234", kind: "reply", text: good, question: "先前他们要求什么？", evidence: sources,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ parts: [part] }) } }] }) }),
  });
  assert.equal(result?.text, good);
});

test("review fails closed on invented quotes, missing coverage, rewritten drafts and unknown ids", () => {
  for (const parts of [
    [{...part,supports:[{id:"a",quote:"stolen equipment"}]}],
    [{...part,supports:[{id:"other",quote:"give them the masks back"}]}],
    [{...part,text:"已经确认他们偷了面罩。"}],
    [],
  ]) assert.equal(applyGroundingReview({kind:"reply",text:good,evidence,review:{parts}}),null);
});

test("questions require both grounded premises and an answer available now", () => {
  const text = "她过来后会发生什么？";
  for (const answerable of [false,undefined,"true"]) {
    assert.equal(applyGroundingReview({kind:"question",text,evidence,
      review:{answerable,parts:[{...part,text}]}}),null);
  }
});

test("removing a contradicted claim cannot leave a clause pretending to answer the question", () => {
  const text = "应该不是马上出发，还有伤员要处理，得先把人安顿好才上路吧。";
  assert.equal(applyGroundingReview({kind:"reply",text,evidence:[{id:"a",text:"So many wounded."}],
    review:{parts:[
      {text:"应该不是马上出发，",verdict:"unsupported"},
      {text:"还有伤员要处理，",verdict:"supported",supports:[{id:"a",quote:"So many wounded."}]},
      {text:"得先把人安顿好才上路吧。",verdict:"unsupported"},
    ]}}),null);
});

test("reviewed social replies need no invented media quote but questions still need evidence", () => {
  const text="好呀，一起看吧。";
  const review={parts:[{text,verdict:"nonfactual",supports:[]}]};
  assert.equal(applyGroundingReview({kind:"reply",text,review})?.text,text);
  assert.equal(applyGroundingReview({kind:"question",text,review:{...review,answerable:true}}),null);
  assert.equal(applyGroundingReview({kind:"reply",text,review:{parts:[{text,verdict:"supported",supports:[]}]}}),null);
});

test("removing a fabricated action cannot leave an unsupported opinion about that action", () => {
  const invented = "这操作悬啊，火堆都烧成那样了还往前摸，我肯定不敢。";
  const opinion = "不过游戏里可能就得这么莽，谁知道呢。";
  const parts = [
    { text: invented, verdict: "unsupported", supports: [] },
    { text: opinion, verdict: "nonfactual", supports: [] },
  ];
  assert.equal(applyGroundingReview({ kind: "reply", text: invented + opinion, review: { parts } }), null);
  assert.equal(applyGroundingReview({ kind: "reply", text: good + invented + opinion, evidence,
    review: { parts: [part, ...parts] } })?.text, good);
});

test("cancelled or failed review never returns an unreviewed draft", async () => {
  const controller = new AbortController(); controller.abort();
  let calls=0;
  assert.equal(await requestGroundingReview({apiBase:"http://127.0.0.1:1234",kind:"reply",text:good,evidence,signal:controller.signal,
    fetchImpl:async()=>{calls++;}}),null);
  assert.equal(calls,0);
  let billed=0;
  assert.equal(await requestGroundingReview({apiBase:"http://127.0.0.1:1234",kind:"reply",text:good,evidence,onUsage:()=>billed++,
    fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:"broken"}}],usage:{prompt_tokens:10}})})}),null);
  assert.equal(billed,1);
});
