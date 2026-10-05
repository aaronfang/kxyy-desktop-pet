import test from "node:test";
import assert from "node:assert/strict";

import { createSharedExperienceWorkspace } from "../src/ai/shared-experience-workspace.js";
import { requestSharedExperienceSummary } from "../src/ai/shared-experience-client.js";
import {
  createSharedExperienceLifecycle,
  estimateDeepseekCostUsd,
} from "../src/ai/shared-experience-lifecycle.js";

test("a truncated paid evidence summary leaves raw evidence available for retry", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({ text: "我们熄灭灯光，让对面士兵不容易瞄准。", startedAtMs: 1000 });
  const lifecycle = createSharedExperienceLifecycle({ workspace,
    summarize: (request) => requestSharedExperienceSummary({ ...request, apiBase: "http://127.0.0.1:1234",
      fetchImpl: async () => ({ ok: true, json: async () => ({
        model: "deepseek-v4-flash", usage: { prompt_tokens: 100, completion_tokens: 600 },
        choices: [{ finish_reason: "length", message: { content: "确认事实：我们熄灭灯光，让" } }],
      }) }),
    }),
  });
  const result = await lifecycle.maybeCompactEvidence({ minEvents: 1 });
  assert.equal(result.compacted, false);
  assert.equal(workspace.snapshot().evidenceBlocks.length, 0);
  assert.equal(workspace.nextEvidenceBatch({ minEvents: 1 }).events.length, 1);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests, 1);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.completion, 600);
});

test("invalid evidence citations fail without compaction and a corrected summary can retry", async () => {
  for (const invalid of [
    "not JSON",
    { events: [{ text: "有人已获救。", status: "observed", supports: [{ id: "unknown", quote: "我们先营救" }] }] },
    { events: [{ text: "有人已获救。", status: "observed", supports: [{ id: "ev-1", quote: "营救成功" }] }] },
    { events: [{ text: "有人已获救。", status: "fact", supports: [{ id: "ev-1", quote: "我们先营救" }] }] },
    { events: [{ text: "缺少引用", status: "observed", supports: [] }] },
    { events: Array(7).fill({ text: "过多条目", status: "uncertain", supports: [{ id: "ev-1", quote: "我们先营救" }] }) },
  ]) {
    const workspace = createSharedExperienceWorkspace();
    workspace.addAudioObservation({ text: "我们先营救那个人。", startedAtMs: 1000 });
    let content = typeof invalid === "string" ? invalid : JSON.stringify(invalid);
    const lifecycle = createSharedExperienceLifecycle({ workspace,
      summarize: (request) => requestSharedExperienceSummary({ ...request, apiBase: "http://127.0.0.1:1234",
        fetchImpl: async (_url,init) => ({ ok: true, json: async () => ({ model: "deepseek-v4-flash",
          usage: { prompt_tokens: 100, completion_tokens: 100 },
          choices: [{ finish_reason: "stop", message: { content:JSON.parse(init.body).messages[0].content.includes("你独立审查")
            ? JSON.stringify({parts:[{text:"解说提出先营救一人。",verdict:"supported",supports:[{id:"ev-1",quote:"我们先营救那个人。"}]}]}) : content } }],
        }) }),
      }),
    });
    assert.equal((await lifecycle.maybeCompactEvidence({ minEvents: 1 })).compacted, false);
    assert.equal(workspace.snapshot().evidenceBlocks.length, 0);
    content = JSON.stringify({ events: [{ text: "解说提出先营救一人。", status: "observed",
      supports: [{ id: "ev-1", quote: "我们先营救那个人。" }] }] });
    assert.equal((await lifecycle.maybeCompactEvidence({ minEvents: 1 })).compacted, true);
    assert.match(workspace.renderPrompt(), /观察支持.*提出先营救/);
    assert.equal(workspace.nextEvidenceBatch({ minEvents: 1 }), null);
    assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests, 3);
  }
});

test("an oversized final summary falls back to a bounded degraded memory recap", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({ text: "解说提出营救计划。", startedAtMs: 1000 });
  let stored = false;
  const lifecycle = createSharedExperienceLifecycle({ workspace,
    persistEpisode: async () => { stored = true; return { stored: true }; },
    summarize: (request) => requestSharedExperienceSummary({ ...request, apiBase: "http://127.0.0.1:1234",
      fetchImpl: async () => ({ ok: true, json: async () => ({
        model: "deepseek-v4-flash", usage: { prompt_tokens: 100, completion_tokens: 700 },
        choices: [{ finish_reason: "stop", message: { content: "长".repeat(1801) } }],
      }) }),
    }),
  });
  const result = await lifecycle.finalize({ endedAtMs: 2000 });
  assert.equal(result.stored, true);
  assert.equal(stored, true);
  assert.equal(lifecycle.snapshot().usage.finalSummary.requests, 1);
  assert.match(result.summary, /降级回顾/);
});

test("visual-only stop stores an explicitly unverified model clue instead of an actionable claim", async () => {
  for (const claimType of [undefined,"screen-text","speech","interpretation"]) {
    const workspace = createSharedExperienceWorkspace({nowMs:()=>0});
    workspace.addVisualObservation({summary:"画面文字提示去见小红。",capturedAtMs:1});
    let calls = 0;
    const lifecycle = createSharedExperienceLifecycle({workspace,
      persistEpisode:async(episode)=>({stored:/画面模型线索（未独立核实）/.test(episode.summary)}),
      summarize:(request)=>requestSharedExperienceSummary({...request,apiBase:"http://127.0.0.1:1234",
        fetchImpl:async()=>{
          calls++;
          return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:20},choices:[{message:{content:JSON.stringify({events:[
            {text:"需要去见小红。",claimType,status:"observed",supports:[{id:"ev-1",quote:"画面文字提示去见小红"}]},
          ]})}}]})};
        }}),
    });
    const result = await lifecycle.finalize({endedAtMs:2});
    assert.equal(result.stored,true);
    assert.equal(result.reason,"summary-fallback");
    assert.match(result.summary,/画面模型线索（未独立核实）/);
    assert.equal(calls,1);
    assert.equal(lifecycle.snapshot().usage.finalSummary.completion,20);
  }
});

test("semantic review failure retains evidence for retry and counts both paid requests", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({text:"Promise me this was the last time.",startedAtMs:1000});
  let claim = "说话者自己承诺这是最后一次。";
  let verdict = "unsupported";
  let calls = 0;
  const lifecycle = createSharedExperienceLifecycle({workspace,
    summarize:(request)=>requestSharedExperienceSummary({...request,apiBase:"http://127.0.0.1:1234",
      fetchImpl:async()=>({ok:true,json:async()=>({model:"deepseek-v4-flash",usage:{prompt_tokens:100,completion_tokens:30},
        choices:[{message:{content:JSON.stringify(++calls % 2 ? {events:[{text:claim,status:"observed",
          supports:[{id:"ev-1",quote:"Promise me this was the last time"}]}]} : {parts:[{text:claim,verdict,
          supports:verdict === "supported" ? [{id:"ev-1",quote:"Promise me this was the last time"}] : []}]})}}]})}),
    }),
  });
  assert.equal((await lifecycle.maybeCompactEvidence({minEvents:1})).reason,"summary-failed");
  assert.equal(workspace.snapshot().evidenceBlocks.length,0);
  assert.equal(workspace.nextEvidenceBatch({minEvents:1}).events.length,1);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests,2);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.completion,60);
  claim = "说话者要求对方保证这是最后一次。";
  verdict = "supported";
  assert.equal((await lifecycle.maybeCompactEvidence({minEvents:1})).compacted,true);
  assert.match(workspace.renderPrompt(),/要求对方保证/);
  assert.doesNotMatch(workspace.renderPrompt(),/自己承诺/);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests,4);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.completion,120);
});

test("failed final review falls back to original evidence instead of a mistaken compacted claim", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({text:"Promise me this was the last time.",startedAtMs:1000});
  workspace.commitEvidenceBlock({eventIds:["ev-1"],summary:"老者承诺这是最后一次。"});
  let calls = 0;
  let stored = false;
  const lifecycle = createSharedExperienceLifecycle({workspace,persistEpisode:async()=>{stored=true;return {stored:true};},
    summarize:(request)=>requestSharedExperienceSummary({...request,apiBase:"http://127.0.0.1:1234",
      fetchImpl:async()=>({ok:true,json:async()=>({model:"deepseek-v4-flash",usage:{prompt_tokens:100,completion_tokens:30},
        choices:[{message:{content:JSON.stringify(++calls === 1 ? {events:[{text:"老者承诺这是最后一次。",status:"observed",
          supports:[{id:"ev-1",quote:"Promise me this was the last time"}]}]} : {parts:[{text:"老者承诺这是最后一次。",verdict:"unsupported",supports:[]}]})}}]})}),
    }),
  });
  const result = await lifecycle.finalize({endedAtMs:2000});
  assert.equal(result.reason,"summary-fallback");
  assert.equal(stored,true);
  assert.match(result.summary,/声音记录：Promise me this was the last time/);
  assert.doesNotMatch(result.summary,/老者承诺/);
  assert.equal(calls,3);
  assert.equal(lifecycle.snapshot().usage.finalSummary.requests,3);
  assert.equal(lifecycle.snapshot().usage.finalSummary.completion,90);
});

test("reviewed final memory retains media and actual user opinion with bounded raw sources", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({text:"我们先回去。",startedAtMs:1000});
  workspace.addChatTurn("user","我觉得这段很有意思。",1500);
  workspace.addChatTurn("assistant","这里肯定藏着宝物。",1600);
  let calls = 0;
  const stored = [];
  const claims = [
    {text:"有人提出先回去。",id:"ev-1",quote:"我们先回去"},
    {text:"用户觉得这段很有意思。",id:"discussion-1",quote:"我觉得这段很有意思"},
  ];
  const lifecycle = createSharedExperienceLifecycle({workspace,persistEpisode:async(episode)=>{stored.push(episode);return {stored:true};},
    summarize:(request)=>requestSharedExperienceSummary({...request,apiBase:"http://127.0.0.1:1234",
      fetchImpl:async(_url,init)=>{
        const body=JSON.parse(init.body);
        if (++calls === 2) {
          const input=JSON.parse(body.messages[1].content);
          assert.deepEqual(input.sources.map(({kind})=>kind),["audio","user"]);
          assert.doesNotMatch(JSON.stringify(input),/宝物/);
        }
        return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(calls === 1
          ? {events:claims.map(({text,id,quote})=>({text,status:"observed",supports:[{id,quote}]}))}
          : {parts:claims.map(({text,id,quote})=>({text,verdict:"supported",supports:[{id,quote}]}))})}}]})};
      },
    }),
  });
  const result=await lifecycle.finalize({endedAtMs:2000});
  assert.equal(result.stored,true);
  assert.equal(stored[0].summary,"有人提出先回去。 用户觉得这段很有意思。");
  assert.equal(lifecycle.snapshot().usage.finalSummary.requests,2);
  await lifecycle.finalize({endedAtMs:2000});
  assert.equal(stored.length,1);
});

test("evidence compaction without provider usage can succeed without fabricating token costs", async () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.addAudioObservation({text:"我们先营救那个人。",startedAtMs:1000});
  const lifecycle = createSharedExperienceLifecycle({workspace,
    summarize:async()=>({summary:"提出营救计划。",usage:null,requestCount:2,model:"deepseek-v4-flash"}),
  });
  assert.equal((await lifecycle.maybeCompactEvidence({minEvents:1})).compacted,true);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests,2);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.total,0);
});

test("test question generation costs are separate from role conversation and spend the same budget", () => {
  const lifecycle = createSharedExperienceLifecycle({ workspace: createSharedExperienceWorkspace(), summarize: async () => ({}), budgetUsd: 1 });
  lifecycle.recordUsage("questionGeneration", { prompt: 1000, completion: 100 }, { model: "deepseek-v4-flash" });
  assert.equal(lifecycle.snapshot().usage.questionGeneration.requests, 1);
  assert.equal(lifecycle.snapshot().usage.conversation.requests, 0);
  assert.ok(lifecycle.snapshot().budget.estimatedCostUsd > 0);
  lifecycle.recordUsage("groundingReview", {prompt:100,completion:30}, {model:"deepseek-v4-flash"});
  assert.equal(lifecycle.snapshot().usage.groundingReview.requests, 1);
});

test("DeepSeek cost estimate separates cached input, uncached input, and output", () => {
  // Sunday 12:00 UTC is off-peak. Flash rates per 1M tokens are
  // $0.003 cache hit, $0.15 cache miss, and $0.60 output.
  const atMs = Date.UTC(2026, 8, 6, 12, 0, 0);
  assert.equal(estimateDeepseekCostUsd({
    model: "deepseek-v4-flash",
    usage: { prompt: 1_000_000, cachedPrompt: 250_000, completion: 100_000 },
    atMs,
  }), 0.17325);
  assert.equal(estimateDeepseekCostUsd({
    model: "unknown-model",
    usage: { prompt: 1_000, completion: 100 },
    atMs,
  }), null);
});

test("balance snapshots keep the starting balance and report provider delta", () => {
  const workspace = createSharedExperienceWorkspace();
  const lifecycle = createSharedExperienceLifecycle({ workspace, summarize: async () => ({ summary: "ok" }) });
  assert.equal(lifecycle.recordBalance({ totalBalance: "12.50", currency: "CNY" }), true);
  assert.equal(lifecycle.recordBalance({ totalBalance: "12.31", currency: "CNY" }), true);
  assert.deepEqual(lifecycle.snapshot().balance, {
    currency: "CNY",
    starting: 12.5,
    current: 12.31,
    delta: -0.19,
  });
  assert.equal(lifecycle.recordBalance({ totalBalance: "not-a-number", currency: "CNY" }), false);
});

test("due shared-experience segment is summarized and the same session continues", async () => {
  let now = 1_000;
  const workspace = createSharedExperienceWorkspace({
    sessionId: "shared-test",
    segmentDurationMs: 1_000,
    nowMs: () => now,
  });
  workspace.addVisualObservation({ summary: "女子走进药铺", capturedAtMs: 1_100 });
  workspace.addAudioObservation({ text: "你愿意吗", startedAtMs: 1_200, endedAtMs: 1_500 });

  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async ({ kind, source }) => {
      assert.equal(kind, "segment");
      assert.match(source, /女子走进药铺/);
      assert.match(source, /你愿意吗/);
      return {
        summary: "两人正在药铺交谈，其中一人询问对方是否愿意。",
        usage: { prompt: 120, completion: 30, total: 150 },
      };
    },
  });

  now = 2_100;
  const result = await lifecycle.maybeRollSegment(now);

  assert.deepEqual(result, {
    rolled: true,
    segmentId: 0,
    summary: "两人正在药铺交谈，其中一人询问对方是否愿意。",
    reason: "summarized",
  });
  assert.equal(workspace.snapshot().segmentId, 1);
  assert.equal(workspace.snapshot().rollingSummary, result.summary);
  assert.deepEqual(workspace.snapshot().visualEvents, []);
  assert.deepEqual(workspace.snapshot().audioEvents, []);
  assert.deepEqual(lifecycle.snapshot().usage.segmentSummary, {
    requests: 1,
    prompt: 120,
    completion: 30,
    total: 150,
    estimatedCostUsd: 0,
  });
  assert.equal(lifecycle.snapshot().status, "active");
});

test("segment rollover sends original evidence and content mode instead of recursively summarizing blocks", async () => {
  let now = 0;
  const workspace = createSharedExperienceWorkspace({
    contentMode: "cinematic",
    segmentDurationMs: 1_000,
    nowMs: () => now,
  });
  workspace.addVisualObservation({ summary: "短发女子进入病房", capturedAtMs: 100 });
  workspace.addAudioObservation({ text: "有人说门已经锁上了。", startedAtMs: 200, endedAtMs: 300 });
  workspace.commitEvidenceBlock({ eventIds: ["ev-1", "ev-2"], summary: "错误旧摘要：女子已经逃走。" });
  let request;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async (value) => {
      request = value;
      return { summary: "本阶段保留原始证据。" };
    },
  });

  now = 1_001;
  await lifecycle.maybeRollSegment(now);
  assert.equal(request.kind, "segment");
  assert.equal(request.contentMode, "cinematic");
  assert.deepEqual(request.evidence.map(({ id, kind, text }) => ({ id, kind, text })), [
    { id: "ev-1", kind: "visual", text: "短发女子进入病房" },
    { id: "ev-2", kind: "audio", text: "有人说门已经锁上了。" },
  ]);
  assert.doesNotMatch(JSON.stringify(request.evidence), /错误旧摘要|block-/);
});

test("concurrent rollover checks share one summary request", async () => {
  let release;
  let calls = 0;
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 1, nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "同一段内容", capturedAtMs: 0 });
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { summary: "唯一阶段总结", usage: { total: 10 } };
    },
  });

  const first = lifecycle.maybeRollSegment(2);
  const second = lifecycle.maybeRollSegment(2);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();

  assert.deepEqual(await second, await first);
  assert.equal(workspace.snapshot().segmentId, 1);
  assert.equal(lifecycle.snapshot().usage.segmentSummary.requests, 1);
});

test("an empty elapsed segment advances without spending a summary request", async () => {
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 10, nowMs: () => 0 });
  workspace.setRollingSummary("此前已有累计概述");
  let calls = 0;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => {
      calls += 1;
      return { summary: "不应调用" };
    },
  });

  const result = await lifecycle.maybeRollSegment(11);

  assert.deepEqual(result, { rolled: true, segmentId: 0, summary: "", reason: "empty-segment" });
  assert.equal(calls, 0);
  assert.equal(workspace.snapshot().rollingSummary, "此前已有累计概述");
  assert.equal(workspace.snapshot().segmentId, 1);
});

test("exhausted budget rolls with a local fallback without another DeepSeek request", async () => {
  const atMs = Date.UTC(2026, 8, 6, 12, 0, 0);
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 1, nowMs: () => atMs });
  workspace.addVisualObservation({ summary: "预算前画面", capturedAtMs: atMs });
  workspace.addChatTurn("assistant", "预算不足时也不能写入的角色猜测", atMs);
  let summaryCalls = 0;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    budgetUsd: 0.001,
    summarize: async () => {
      summaryCalls += 1;
      return { summary: "不应调用" };
    },
  });
  lifecycle.recordUsage("conversation", {
    prompt: 10_000,
    completion: 1_000,
    total: 11_000,
  }, { model: "deepseek-v4-flash", atMs });

  const result = await lifecycle.maybeRollSegment(atMs + 2);

  assert.equal(summaryCalls, 0);
  assert.equal(result.rolled, true);
  assert.equal(result.reason, "budget-fallback");
  assert.match(result.summary, /预算前画面/);
  assert.doesNotMatch(result.summary, /角色猜测/);
  assert.deepEqual(lifecycle.snapshot().budget, {
    limitUsd: 0.001,
    estimatedCostUsd: 0.0021,
    exhausted: true,
  });
  assert.equal(lifecycle.snapshot().status, "budget-saving");
});

test("failed segment summary falls back locally and a later segment can retry", async () => {
  let calls = 0;
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 10, nowMs: () => 0 });
  workspace.addAudioObservation({ text: "第一段台词", startedAtMs: 1, endedAtMs: 2 });
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return { summary: "第二段在线总结", usage: { total: 12 } };
    },
  });

  const degraded = await lifecycle.maybeRollSegment(11);
  assert.equal(degraded.reason, "summary-fallback");
  assert.match(degraded.summary, /第一段台词/);
  assert.equal(lifecycle.snapshot().summaryFailures, 1);
  assert.equal(lifecycle.snapshot().status, "summary-degraded");

  workspace.addVisualObservation({ summary: "第二段画面", capturedAtMs: 12 });
  const recovered = await lifecycle.maybeRollSegment(22);
  assert.equal(recovered.reason, "summarized");
  assert.equal(recovered.summary, "第二段在线总结");
  assert.equal(lifecycle.snapshot().status, "active");
  assert.equal(calls, 2);
});

test("later segment summaries use fresh evidence instead of recursively summarizing the prior overview", async () => {
  let now = 0;
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 10, nowMs: () => now });
  const sources = [];
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async ({ source }) => {
      sources.push(source);
      return { summary: sources.length === 1 ? "累计：人物出发" : "累计：人物出发后抵达车站" };
    },
  });
  workspace.addVisualObservation({ summary: "人物出发", capturedAtMs: 1 });
  now = 11;
  await lifecycle.maybeRollSegment(now);
  workspace.addVisualObservation({ summary: "抵达车站", capturedAtMs: 12 });
  now = 22;
  await lifecycle.maybeRollSegment(now);

  assert.doesNotMatch(sources[1], /此前概述|累计：人物出发/);
  assert.match(sources[1], /抵达车站/);
  assert.equal(workspace.snapshot().rollingSummary, "累计：人物出发后抵达车站");
});

test("finalize summarizes and persists one bounded episode even when stop repeats", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "shared-final", nowMs: () => 1_000 });
  workspace.setRollingSummary("前半段两人在药铺相识。");
  workspace.addVisualObservation({ summary: "二人在雨中告别", capturedAtMs: 2_000 });
  workspace.addChatTurn("user", "这一段有点难过", 2_100);
  let summaryCalls = 0;
  const persisted = [];
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async ({ kind, source }) => {
      summaryCalls += 1;
      assert.equal(kind, "final");
      assert.doesNotMatch(source, /前半段两人在药铺相识/);
      assert.match(source, /二人在雨中告别/);
      assert.match(source, /这一段有点难过/);
      return {
        summary: "我们一起看了古风短剧：两人在药铺相识，最后在雨中告别；用户觉得结尾有点难过。",
        usage: { prompt: 200, completion: 50, total: 250 },
      };
    },
    persistEpisode: async (episode) => {
      persisted.push(episode);
      return { stored: true, duplicate: false };
    },
  });

  const first = lifecycle.finalize({ endedAtMs: 3_000 });
  const second = lifecycle.finalize({ endedAtMs: 3_000 });
  const result = await first;

  assert.deepEqual(await second, result);
  assert.equal(summaryCalls, 1);
  assert.deepEqual(persisted, [{
    sessionId: "shared-final",
    summary: result.summary,
    occurredAtMs: 3_000,
    source: "shared-experience",
  }]);
  assert.equal(result.stored, true);
  assert.equal(result.reason, "summarized");
  assert.equal(lifecycle.snapshot().status, "finalized");
  assert.equal(lifecycle.snapshot().usage.finalSummary.requests, 1);
  assert.equal("visualEvents" in persisted[0], false);
  assert.equal("audioEvents" in persisted[0], false);
});

test("cancelling finalization drops a late summary without persisting it", async () => {
  let release;
  let persistCalls = 0;
  const workspace = createSharedExperienceWorkspace({ sessionId: "old-session", nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "旧会话画面", capturedAtMs: 1 });
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => new Promise((resolve) => { release = resolve; }),
    persistEpisode: async () => {
      persistCalls += 1;
      return { stored: true };
    },
  });

  const pending = lifecycle.finalize({ endedAtMs: 2 });
  await Promise.resolve();
  lifecycle.cancel();
  release({ summary: "迟到总结", usage: { total: 10 } });

  assert.deepEqual(await pending, { cancelled: true, stored: false, reason: "cancelled" });
  assert.equal(persistCalls, 0);
  assert.equal(lifecycle.snapshot().status, "cancelled");
});

test("finalize skips DeepSeek and Memory when no visual or audio evidence exists", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "shared-empty", nowMs: () => 0 });
  workspace.addChatTurn("user", "看到了什么？", 1);
  let summaryCalls = 0;
  let persistCalls = 0;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => {
      summaryCalls += 1;
      return { summary: "不应生成" };
    },
    persistEpisode: async () => {
      persistCalls += 1;
      return { stored: true };
    },
  });

  const result = await lifecycle.finalize({ endedAtMs: 2 });

  assert.equal(result.stored, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, "no-evidence");
  assert.equal(result.completionAudit.segmentId, 0);
  assert.equal(result.completionAudit.finalSummaryRequests, 0);
  assert.equal(summaryCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(lifecycle.snapshot().status, "finalized-without-memory");
});

test("persistence failure keeps the final summary available for UI cleanup", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "shared-persist-failure", nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "人物在海边散步", capturedAtMs: 1 });
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => ({ summary: "我们一起看了人物在海边散步。" }),
    persistEpisode: async () => { throw new Error("database busy"); },
  });

  const result = await lifecycle.finalize({ endedAtMs: 2 });

  assert.equal(result.summary, "我们一起看了人物在海边散步。");
  assert.equal(result.stored, false);
  assert.equal(result.reason, "persist-failed");
  assert.equal(lifecycle.snapshot().status, "finalized-without-memory");
});

test("final summary is rebuilt from the evidence journal without assistant claims", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "evidence-final", maxEvents: 1, nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "最早画面是地下神殿", capturedAtMs: 1 });
  workspace.addVisualObservation({ summary: "后来画面切到医院", capturedAtMs: 2 });
  workspace.addChatTurn("assistant", "这是一个时间循环故事", 3);
  workspace.addChatTurn("user", "我觉得主角变强得太快", 4);
  let finalSource = "";
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async ({ kind, source }) => {
      if (kind === "final") finalSource = source;
      return { summary: "基于证据生成的总结" };
    },
    persistEpisode: async () => ({ stored: true }),
  });

  await lifecycle.finalize({ endedAtMs: 10 });

  assert.match(finalSource, /最早画面是地下神殿/);
  assert.match(finalSource, /后来画面切到医院/);
  assert.doesNotMatch(finalSource, /时间循环故事/);
});

test("finalize crossing the segment deadline rolls exactly once before final summary", async () => {
  const workspace = createSharedExperienceWorkspace({ segmentDurationMs: 100, nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "边界前最后一个画面", capturedAtMs: 90 });
  const kinds = [];
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async ({ kind }) => {
      kinds.push(kind);
      return { summary: kind === "segment" ? "第一段证据总结" : "最终证据总结" };
    },
    persistEpisode: async () => ({ stored: true }),
  });

  const first = lifecycle.finalize({ endedAtMs: 102 });
  const second = lifecycle.finalize({ endedAtMs: 102 });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(kinds, ["segment", "final"]);
  assert.equal(workspace.snapshot().segmentId, 1);
  assert.equal(firstResult.completionAudit.segmentId, 1);
  assert.equal(firstResult.completionAudit.segmentSummaryRequests, 1);
  assert.equal(firstResult.completionAudit.finalSummaryRequests, 1);
  assert.equal(firstResult.completionAudit.lifecycle.usage.segmentSummary.requests, 1);
  assert.equal(firstResult.completionAudit.lifecycle.usage.finalSummary.requests, 1);
  assert.deepEqual(secondResult.completionAudit, firstResult.completionAudit);
});

test("evidence compaction summarizes only raw evidence and records its own usage", async () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "第一条画面", capturedAtMs: 1 });
  workspace.addAudioObservation({ text: "第一句旁白", startedAtMs: 2, endedAtMs: 3 });
  workspace.addChatTurn("assistant", "角色编出的结论", 4);
  const calls = [];
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async (request) => {
      calls.push(request);
      return { summary: "[确认] 第一条画面与第一句旁白属于同一段。", usage: { prompt: 20, completion: 10, total: 30 } };
    },
  });

  const result = await lifecycle.maybeCompactEvidence({ minEvents: 2, maxEvents: 10 });

  assert.equal(result.compacted, true);
  assert.equal(calls[0].kind, "evidence");
  assert.match(calls[0].source, /第一条画面/);
  assert.doesNotMatch(calls[0].source, /角色编出的结论/);
  assert.equal(lifecycle.snapshot().usage.evidenceSummary.requests, 1);
});

test("final summary with a title conflicting with the confirmed primer is not persisted", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "title-conflict", nowMs: () => 0 });
  workspace.addPrimer({ title: "韩漫《暗影君王》解说", facts: ["正式名：我独自升级", "别名：Solo Leveling"] });
  workspace.addVisualObservation({ summary: "猎人在地下城战斗", capturedAtMs: 1 });
  let persistCalls = 0;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => ({ summary: "我们一起看了《火影忍者》和《咒术回战》的混剪。" }),
    persistEpisode: async () => { persistCalls += 1; return { stored: true }; },
  });

  const result = await lifecycle.finalize({ endedAtMs: 2 });

  assert.equal(result.stored, false);
  assert.equal(result.reason, "evidence-conflict");
  assert.equal(persistCalls, 0);
});

test("final summary failure audit retains only an allow-listed reason", async () => {
  for (const [code, expected] of [["invalid-structure", "invalid-structure"], ["private provider output", "unknown"]]) {
    const workspace = createSharedExperienceWorkspace({ sessionId: "failure-audit", nowMs: () => 0 });
    workspace.addAudioObservation({ text: "队伍来到门前。", startedAtMs: 1, endedAtMs: 2 });
    const lifecycle = createSharedExperienceLifecycle({ workspace,
      summarize: async () => { const error = new Error("private content"); error.summaryFailureCode = code; throw error; },
      persistEpisode: async () => ({ stored: true }),
    });
    const result = await lifecycle.finalize({ endedAtMs: 3 });
    assert.equal(result.completionAudit.finalSummaryFailureCode, expected);
    assert.doesNotMatch(JSON.stringify(result.completionAudit), /private/);
  }
});

test("failed final summary persists a bounded degraded recap instead of losing the session", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "shared-summary-failure", nowMs: () => 0 });
  workspace.addAudioObservation({
    text: "这是一整段不应直接进入记忆的 ASR 原文",
    startedAtMs: 1,
    endedAtMs: 2,
  });
  let persistCalls = 0;
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => { throw new Error("timeout"); },
    persistEpisode: async () => {
      persistCalls += 1;
      return { stored: true };
    },
  });

  const result = await lifecycle.finalize({ endedAtMs: 3 });

  assert.equal(result.stored, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, "summary-fallback");
  assert.equal(result.completionAudit.segmentId, 0);
  assert.equal(result.completionAudit.finalSummaryRequests, 0);
  assert.equal(persistCalls, 1);
  assert.match(result.summary, /降级回顾/);
  assert.equal(lifecycle.snapshot().status, "finalized");
});

test("semantic review failure still persists a bounded recap from visual-only evidence", async () => {
  const workspace = createSharedExperienceWorkspace({ sessionId: "shared-visual-stop", nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "女子走进药铺并关上门。", capturedAtMs: 1 });
  const stored = [];
  const lifecycle = createSharedExperienceLifecycle({
    workspace,
    summarize: async () => {
      const error = new Error("review unavailable");
      error.summaryFailureCode = "review-unavailable";
      error.summaryUsage = { usage: { prompt: 20, completion: 0, total: 20 }, requestCount: 2 };
      throw error;
    },
    persistEpisode: async (episode) => { stored.push(episode); return { stored: true, duplicate: false }; },
  });
  const result = await lifecycle.finalize({ endedAtMs: 2 });
  assert.equal(result.reason, "summary-fallback");
  assert.equal(result.stored, true);
  assert.equal(stored.length, 1);
  assert.match(result.summary, /女子走进药铺并关上门/);
  assert.equal(result.completionAudit.finalSummaryFailureCode, "review-unavailable");
});
