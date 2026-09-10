import test from "node:test";
import assert from "node:assert/strict";

import { requestSharedExperienceSummary, requestSharedExperienceQuestion } from "../src/ai/shared-experience-client.js";

test("summary prompts weight raw evidence for narrated, cinematic, livestream, and low-speech game", async () => {
  const cases = [
    ["narrated", /ASR.*主线.*画面.*补充/],
    ["cinematic", /连续画面.*对白.*共同/],
    ["livestream", /实时画面.*零散语音/],
    ["low-speech-game", /游戏动作.*场景变化.*主线/],
  ];
  for (const [contentMode, expected] of cases) {
    let prompt = "";
    await requestSharedExperienceSummary({
      apiBase: "http://127.0.0.1:1234",
      kind: "evidence",
      contentMode,
      evidence: [
        { id: "ev-1", kind: "visual", text: "人物向门口移动。", atMs: 1000 },
        { id: "ev-2", kind: "audio", text: "有人说小心。", atMs: 1200 },
      ],
      fetchImpl: async (_url, init) => {
        prompt = JSON.parse(init.body).messages[1].content;
        return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"events":[]}' } }] }) };
      },
    });
    assert.match(prompt, expected, contentMode);
  }
});

test("final recap generation reads original audio omitted by previous summaries", async () => {
  const evidence = [
    {id:"ev-95",kind:"audio",atMs:1000,text:"They took the girl to the base chief for interrogation."},
    {id:"ev-101",kind:"audio",atMs:2000,text:"这里我们先去把电闸关了，这样。"},
    {id:"ev-103",kind:"audio",atMs:7000,text:"可以去潜行寻找安娜了。"},
  ];
  let calls = 0;
  const result = await requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",evidence,
    source:"[block-1] 旧摘要误写：发电厂爆炸，去见小红。",
    fetchImpl:async(_url,init)=>{
      if (++calls === 1) {
        const prompt = JSON.parse(init.body).messages[1].content;
        for (const event of evidence) assert.ok(prompt.includes(event.text), `missing raw ${event.id}`);
        assert.doesNotMatch(prompt,/发电厂爆炸|去见小红/);
      }
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(calls === 1
        ? {events:[{text:"有人提出先关电闸。",status:"observed",supports:[{id:"ev-101",quote:"这里我们先去把电闸关了"}]}]}
        : {parts:[{index:0,verdict:"supported",supports:[{id:"ev-101",quote:"这里我们先去把电闸关了"}]}]})}}]})};
    },
  });
  assert.equal(result.summary,"有人提出先关电闸。");
});

test("final recap accepts eight valid sourced events when citation rendering exceeds the segment limit", async () => {
  const evidence = Array.from({ length: 16 }, (_, index) => ({
    id: `ev-${index + 1}`,
    kind: "audio",
    text: `第${index + 1}段旁白明确交代了当前行动和结果。${"原始说明".repeat(20)}`.slice(0, 118),
  }));
  const events = Array.from({ length: 8 }, (_, index) => ({
    text: `第${index + 1}个事件概括当前行动及其结果，并保留必要限定；这段合法正文刻意接近最终回顾的单条长度上限，但八条正文合计仍小于记忆摘要上限。`.repeat(2).slice(0, 150),
    claimType: "speech",
    status: "observed",
    supports: evidence.slice(index * 2, index * 2 + 2).map((event) => ({ id: event.id, quote: event.text })),
  }));
  assert.ok(events.map((event) => `${event.text}${event.supports.map((support) => support.quote).join("")}`).join("").length > 2400);
  let calls = 0;
  const result = await requestSharedExperienceSummary({
    apiBase: "http://127.0.0.1:1234",
    kind: "final",
    evidence,
    fetchImpl: async () => {
      const content = ++calls === 1
        ? { events }
        : { parts: events.map((event, index) => ({
          index,
          text: event.text,
          verdict: "supported",
          supports: event.supports,
        })) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.summary.split("\n").length, 8);
});

test("final recap keeps bounded original fields without leaking prior claims or metadata", async () => {
  const first = {id:"ev-1",kind:"audio",atMs:0,text:"开场有人提出寻找出口。",privatePath:"not-for-provider"};
  const last = {id:"ev-2048",kind:"audio",atMs:1800000,text:"结束前终于找到出口。"};
  const evidence = [first,...Array.from({length:2046},(_,index)=>({id:`ev-${index+2}`,kind:"visual",text:"走廊。"})),last,
    {id:"discussion-1",kind:"user",text:"这个结局让我松了口气。"},
    {id:"identity-only",kind:"identity",text:"用户确认标题：测试影片"},
    {id:"block-1",kind:"summary",text:"旧摘要假设有时间循环。"},
    {id:"assistant-1",kind:"assistant",text:"角色猜测有人失踪。"}];
  let calls = 0;
  await assert.rejects(requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",evidence,
    fetchImpl:async(_url,init)=>{
      calls++;
      const prompt = JSON.parse(init.body).messages[1].content;
      assert.ok(prompt.includes(first.text));
      assert.ok(prompt.includes(last.text));
      assert.match(prompt,/这个结局让我松了口气/);
      assert.doesNotMatch(prompt,/not-for-provider|时间循环|有人失踪/);
      return {ok:true,json:async()=>({choices:[{message:{content:'{"events":[]}'}}]})};
    }}),/总结不完整/);
  assert.equal(calls,1);
  for (const invalid of [Array(2306).fill(first),[{...first,text:"字".repeat(501)}],[{...first,id:""}]]) {
    await assert.rejects(requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",evidence:invalid,
      fetchImpl:async()=>assert.fail("invalid evidence must not spend tokens")}),/最终总结证据/);
  }
});

test("final memory excludes visual-only screen text even when the reviewer approves it", async () => {
  const evidence = [
    {id:"ev-1",kind:"audio",text:"我们先去把电闸关了。"},
    {id:"ev-2",kind:"visual",text:"文字显示冰岛雪原，发电厂爆炸，去见小红。"},
    {id:"ev-3",kind:"visual",text:"昏暗的地下通道。"},
  ];
  let calls = 0;
  const result = await requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",evidence,
    fetchImpl:async(_url,init)=>{
      calls++;
      const request = calls > 1 ? JSON.parse(JSON.parse(init.body).messages[1].content) : null;
      const content = calls === 1 ? {events:[
        {text:"旁白提出关电闸。",claimType:"speech",status:"observed",supports:[{id:"ev-1",quote:evidence[0].text}]},
        {text:"任务是去冰岛雪原见小红。",claimType:"screen-text",status:"observed",supports:[{id:"ev-2",quote:evidence[1].text}]},
        {text:"昏暗的地下通道。",claimType:"appearance",status:"observed",supports:[{id:"ev-3",quote:evidence[2].text}]},
      ]} : {parts:request.sentences.map(({index,text})=>({index,verdict:"supported",supports:[{id:text.includes("电闸")?"ev-1":text.includes("小红")?"ev-2":"ev-3",quote:text.includes("电闸")?evidence[0].text:text.includes("小红")?evidence[1].text:evidence[2].text}]}))};
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(content)}}]})};
    }});
  assert.match(result.summary,/旁白提出关电闸/);
  assert.doesNotMatch(result.summary,/小红|冰岛|发电厂/);
  assert.match(result.summary,/画面模型线索（未独立核实）：昏暗的地下通道/);
});

test("low-speech game final recap retains directly visible actions as unverified visual evidence", async () => {
  const evidence = [{ id: "ev-1", kind: "visual", text: "玩家举枪后退并躲到木箱后。", atMs: 1000 }];
  let calls = 0;
  const result = await requestSharedExperienceSummary({
    apiBase: "http://127.0.0.1:1234",
    kind: "final",
    contentMode: "low-speech-game",
    evidence,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(++calls === 1
      ? { events: [{ text: "玩家举枪后退并躲到木箱后。", claimType: "visual-action", status: "observed", supports: [{ id: "ev-1", quote: evidence[0].text }] }] }
      : { parts: [{ text: "玩家举枪后退并躲到木箱后。", verdict: "supported", supports: [{ id: "ev-1", quote: evidence[0].text }] }] }) } }] }) }),
  });
  assert.equal(result.summary, "画面模型线索（未独立核实）：玩家举枪后退并躲到木箱后。");
  assert.equal(calls, 2);
});

test("final recap omits player controls without removing an adjacent scene or spoken instructions", async () => {
  const evidence = [
    {id:"ev-1",kind:"visual",text:"黑暗画面中央有播放按钮。"},
    {id:"ev-2",kind:"visual",text:"浏览器显示调试提示。雪地里站着一个人。"},
    {id:"ev-3",kind:"audio",text:"请按播放按钮，然后看看这个场景。"},
  ];
  let submitted;
  await assert.rejects(requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",evidence,
    fetchImpl:async(_url,init)=>{
      submitted = JSON.parse(init.body).messages[1].content;
      return {ok:true,json:async()=>({choices:[{message:{content:'{"events":[]}'}}]})};
    }}),/总结不完整/);
  assert.doesNotMatch(submitted,/黑暗画面中央有播放按钮|浏览器显示调试提示/);
  assert.match(submitted,/雪地里站着一个人/);
  assert.match(submitted,/请按播放按钮，然后看看这个场景/);
});

test("evidence summary cannot promote a request into the speaker's own promise", async () => {
  let calls = 0;
  const promise = "老者承诺这是最后一次。";
  const evidence = [{ id: "ev-90", kind: "audio", text: "Promise me this was the last time, I'll see you later." }];
  await assert.rejects(requestSharedExperienceSummary({ apiBase: "http://127.0.0.1:1234", kind: "evidence", evidence,
    fetchImpl: async () => {
      calls++;
      const content = calls === 1
        ? JSON.stringify({ events: [{ text: promise, status: "observed", supports: [{ id: "ev-90", quote: "Promise me this was the last time" }] }] })
        : JSON.stringify({ parts: [{ text: promise, verdict: "unsupported", supports: [] }] });
      return { ok: true, json: async () => ({ model: "deepseek-v4-flash", usage: { prompt_tokens: 100, completion_tokens: 30 },
        choices: [{ finish_reason: "stop", message: { content } }] }) };
    },
  }), (error) => error.summaryUsage?.requestCount === 2 && error.summaryUsage.usage.completion === 60);
  assert.equal(calls, 2);
});

test("evidence summaries retain compact events, exact sources and explicit uncertainty", async () => {
  const evidence = [
    { id: "ev-1", kind: "audio", text: "我们先营救伊尔马克。" },
    { id: "ev-2", kind: "audio", text: "本来想跳过去检查屋子的，但是。" },
  ];
  const claims = ["解说提出先营救一人，名字转写为伊尔马克，未确认。", "检查屋子的计划后接转折，但原因未听完整。"];
  let calls = 0;
  const result = await requestSharedExperienceSummary({ apiBase: "http://127.0.0.1:1234", kind: "evidence", evidence,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify(++calls === 1 ? { events: [
        { text: claims[0], status: "observed", supports: [{ id: "ev-1", quote: "我们先营救伊尔马克。" }] },
        { text: claims[1], status: "uncertain", supports: [{ id: "ev-2", quote: "但是，" }] },
      ] } : {parts:claims.map((text,index) => ({text,verdict:"supported",supports:[{id:evidence[index].id,quote:evidence[index].text}]}))}),
    } }] }) }),
  });
  assert.match(result.summary, /观察支持.*先营救/);
  assert.match(result.summary, /不确定.*原因未听完整/);
  assert.match(result.summary, /ev-1.*我们先营救伊尔马克/);
  assert.doesNotMatch(result.summary, /确认事实|"events"/);
  assert.equal(result.requestCount, 2);
});

test("summary review retains whole supported events without splicing a rejected claim", async () => {
  const evidence = [{id:"ev-1",kind:"audio",text:"我们先营救那个人。"}];
  let calls = 0;
  const result = await requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"evidence",evidence,
    fetchImpl:async()=>({ok:true,json:async()=>({model:"deepseek-v4-flash",usage:{prompt_tokens:100,completion_tokens:30},
      choices:[{message:{content:JSON.stringify(++calls === 1 ? {events:[
        {text:"提出先营救一人",status:"observed",supports:[{id:"ev-1",quote:"我们先营救那个人"}]},
        {text:"人已获救。",status:"observed",supports:[{id:"ev-1",quote:"营救那个人"}]},
      ]} : {parts:[
        {text:"提出先营救一人。",verdict:"supported",supports:[{id:"ev-1",quote:"我们先营救那个人"}]},
        {text:"人已获救。",verdict:"unsupported",supports:[]},
      ]})}}]})}),
  });
  assert.match(result.summary, /提出先营救一人/);
  assert.doesNotMatch(result.summary, /已获救/);
  assert.deepEqual(result.usage,{prompt:200,cachedPrompt:0,completion:60,total:260});
});

test("summary review shares the operation deadline and preserves billed generation usage", async () => {
  let calls = 0;
  let aborted = false;
  await assert.rejects(requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"evidence",timeoutMs:10,
    evidence:[{id:"ev-1",kind:"audio",text:"我们先营救那个人。"}],
    fetchImpl:async(_url,init)=>{
      if (++calls === 1) return {ok:true,json:async()=>({model:"deepseek-v4-flash",usage:{prompt_tokens:100,completion_tokens:30},
        choices:[{message:{content:JSON.stringify({events:[{text:"提出营救计划。",status:"observed",supports:[{id:"ev-1",quote:"我们先营救那个人"}]}]})}}]})};
      return new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>{aborted=true;reject(new Error("timeout"));}));
    },
  }),error=>error.summaryUsage?.requestCount === 2 && error.summaryUsage.usage.completion === 30);
  assert.equal(aborted,true);
});

test("summary review cannot borrow a later scene to approve an earlier claim", async () => {
  const evidence = [
    {id:"early",kind:"visual",text:"两人站在房间里。",atMs:1000},
    {id:"later",kind:"visual",text:"工业设施。",atMs:100000},
  ];
  let calls = 0;
  await assert.rejects(requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"evidence",evidence,
    fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(++calls === 1
      ? {events:[{text:"两人站在工业设施中。",status:"observed",supports:[{id:"early",quote:"两人站在房间里"}]}]}
      : {parts:[{text:"两人站在工业设施中。",verdict:"supported",supports:[{id:"early",quote:"两人站在房间里"},{id:"later",quote:"工业设施"}]}]})}}]})}),
  }),/总结不完整/);
});

test("a malformed recap item cannot erase a separately verified event", async () => {
  let calls = 0;
  const result = await requestSharedExperienceSummary({apiBase:"http://127.0.0.1:1234",kind:"final",
    evidence:[{id:"ev-1",kind:"audio",text:"我们先回去。"}],
    fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(++calls === 1 ? {events:[
      {text:"有人提出先回去。",status:"observed",supports:[{id:"ev-1",quote:"我们先回去"}]},
      {text:"他们已经回家。",status:"observed",supports:[{id:"unknown",quote:"已到家"}]},
    ]} : {parts:[{text:"有人提出先回去。",verdict:"supported",supports:[{id:"ev-1",quote:"我们先回去"}]}]})}}]})}),
  });
  assert.equal(result.summary,"有人提出先回去。");
  assert.equal(result.requestCount,2);
});

test("English evidence supports a natural Chinese viewer question, not dialogue impersonation", async () => {
  const evidence = [{id: "a", kind: "audio", text: "Are you trying to kill me with worry? What if next time you don't return?"}];
  for (const [prompt, accepted] of [
    ["她为什么这么担心他回不来？", true],
    ["你不回来，我该怎么办？", false],
    ["她的worry是因为什么？", false],
  ]) {
    const result = await requestSharedExperienceQuestion({apiBase: "http://127.0.0.1:1234", evidence,
      fetchImpl: async () => ({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({prompt,topic:"worry",anchorEventIds:["a"]})}}]})}),
    });
    assert.equal(Boolean(result), accepted);
  }
});

test("browser debug chrome cannot become a video question even when the model selects it", async () => {
  let supplied;
  const result = await requestSharedExperienceQuestion({
    apiBase: "http://127.0.0.1:1234",
    evidence: [{ id: "v", kind: "visual", text: "AI 助手正在调试浏览器。角色拿着手电走进隧道。" }],
    fetchImpl: async (_url, init) => {
      supplied = JSON.parse(init.body).messages[1].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        prompt: "这个AI助手在调试浏览器时，具体在操作哪个页面或功能？",
        topic: "AI助手", anchorEventIds: ["v"],
      }) } }] }) };
    },
  });
  assert.equal(result, null);
  assert.doesNotMatch(supplied, /AI 助手/);
  assert.match(supplied, /手电/);
});

test("question anchors may omit an answer adjective without losing the exact source noun", async () => {
  const result=await requestSharedExperienceQuestion({apiBase:"http://127.0.0.1:1234",
    evidence:[{id:"v",kind:"visual",text:"一只手握着一根生锈的金属杆。"}],
    fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({
      prompt:"那只手握着的金属杆是什么样子的？",topic:"生锈的金属杆",anchorEventIds:["v"],
    })}}]})}),
  });
  assert.equal(result?.topic,"金属杆");
  assert.deepEqual(result?.anchorEventIds,["v"]);
});

test("an exact quoted answer grounds a question even when its topic names the answer location", async () => {
  const prompt="听到安娜的声音后，他判断安娜在哪里？";
  const source="是安娜的声音，他应该就在前方的屋子里。";
  for (const [answerQuote,accepted] of [[source,true],["安娜正在车站里。",false]]) {
    const result=await requestSharedExperienceQuestion({apiBase:"http://127.0.0.1:1234",
      evidence:[{id:"a",kind:"audio",text:source}],
      fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({
        prompt,topic:"前方的屋子里",anchorEventIds:["a"],answer:"他推测在前方屋子里",answerQuote,
      })}}]})}),
    });
    assert.equal(Boolean(result),accepted);
  }
});

test("summary request aborts at its bounded timeout", async () => {
  let observedSignal = null;
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

  await assert.rejects(
    requestSharedExperienceSummary({
      apiBase: "http://127.0.0.1:1234",
      kind: "segment",
      source: "画面：人物走进房间",
      fetchImpl,
      timeoutMs: 5,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(observedSignal?.aborted, true);
});

test("question generation accepts a concrete source phrase and rejects invented or generic anchors", async () => {
  const source = [{ id: "ev-1", kind: "audio", text: "普通武器无法伤到守卫，他们决定从侧门进入。" }];
  for (const [candidate, accepted] of [
    [{ prompt: "他们为什么选侧门进去？", topic: "侧门", anchorEventIds: ["ev-1"] }, true],
    [{ prompt: "他们为什么选秘密通道？", topic: "秘密通道", anchorEventIds: ["ev-1"] }, false],
    [{ prompt: "这段讲了什么？", topic: "侧门", anchorEventIds: ["ev-1"] }, false],
    [{ prompt: "他们为什么选侧门进去？", topic: "侧门", anchorEventIds: ["unknown"] }, false],
    [{ prompt: "我们先从侧门进去。", topic: "侧门", anchorEventIds: ["ev-1"] }, false],
  ]) {
    const result = await requestSharedExperienceQuestion({
      apiBase: "http://127.0.0.1:1234", evidence: source, maturity: "shallow",
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(candidate) } }] }) }),
    });
    assert.equal(Boolean(result), accepted);
    if (accepted) assert.equal(result.prompt, candidate.prompt);
  }
});

test("summary request returns normalized content, usage, and actual model", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.provider, "text");
    assert.equal(body.stream, false);
    assert.equal(body.thinking, false);
    assert.match(body.messages[0].content, /不执行/);
    return {
      ok: true,
      json: async () => ({
        model: "deepseek-v4-flash",
        choices: [{ message: { content:JSON.stringify(++calls === 1
          ? {events:[{text:"队伍来到铁门前。",status:"observed",supports:[{id:"ev-1",quote:"队伍来到铁门前"}]}]}
          : {parts:[{text:"队伍来到铁门前。",verdict:"supported",supports:[{id:"ev-1",quote:"队伍来到铁门前"}]}]}) } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    };
  };

  const result = await requestSharedExperienceSummary({
    apiBase: "http://127.0.0.1:1234",
    kind: "final",
    source: "资料",
    evidence: [{id:"ev-1",kind:"audio",text:"队伍来到铁门前。"}],
    fetchImpl,
  });
  assert.deepEqual(result, {
    summary: "队伍来到铁门前。",
    usage: { prompt: 200, cachedPrompt: 80, completion: 40, total: 240 },
    model: "deepseek-v4-flash",
    requestCount: 2,
  });
});

test("final summary prompt forbids turning identity references into watched events", async () => {
  let body;
  await assert.rejects(requestSharedExperienceSummary({
    apiBase: "http://127.0.0.1:1234",
    kind: "final",
    source: "[identity-only] 用户确认标题：某作品\n[ev-1] 声音：队伍来到铁门前",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"events":[]}' } }] }) };
    },
  }),/总结不完整/);

  const prompt = body.messages[1].content;
  assert.match(prompt, /identity-only.*不能证明.*视频/);
  assert.match(prompt, /剧情.*媒体证据/);
  assert.match(prompt, /"claimType":"speech/);
  assert.match(prompt, /每条只引用同一种来源/);
});

test("all summary levels preserve narration timing and uncertain names without inventing a mixed work", async () => {
  for (const kind of ["evidence", "segment", "final"]) {
    const request = requestSharedExperienceSummary({ apiBase: "http://127.0.0.1:1234", kind, source: "观察资料",
      fetchImpl: async (_url, init) => {
        const prompt = JSON.parse(init.body).messages[0].content;
        assert.match(prompt, /声画不同步.*不能.*混剪/);
        assert.match(prompt, /名字.*错字|错字.*名字/);
        assert.match(prompt, /浏览器.*调试提示.*不.*总结/);
        assert.match(prompt, /ASR.*不是用户.*感受/);
        return { ok: true, json: async () => ({ choices: [{ message: { content: kind === "segment" ? "总结" : '{"events":[]}' } }] }) };
      },
    });
    if (kind === "final") await assert.rejects(request,/总结不完整/);
    else await request;
  }
});

test("question generation fails closed on timeout and counts billed malformed responses", async () => {
  const evidence = [{ id: "e", kind: "audio", text: "队员从侧门进入了院子。" }];
  let aborted = false;
  const timedOut = await requestSharedExperienceQuestion({ apiBase: "http://127.0.0.1:1234", evidence, timeoutMs: 2,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); });
    }),
  });
  assert.equal(timedOut, null);
  assert.equal(aborted, true);
  let accounted = 0;
  const malformed = await requestSharedExperienceQuestion({ apiBase: "http://127.0.0.1:1234", evidence,
    onUsage: () => { accounted++; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not JSON" } }] }) }),
  });
  assert.equal(malformed, null);
  assert.equal(accounted, 1);
});
