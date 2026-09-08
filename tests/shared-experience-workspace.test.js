import test from "node:test";
import assert from "node:assert/strict";
import { createSharedExperienceWorkspace } from "../src/ai/shared-experience-workspace.js";

test("workspace deduplicates consecutive observations and keeps a bounded timeline", () => {
  const workspace = createSharedExperienceWorkspace({ maxEvents: 2, nowMs: () => 1000 });
  workspace.addVisualObservation({ summary: "人物近景", capturedAtMs: 1000 });
  workspace.addVisualObservation({ summary: "人物近景", capturedAtMs: 2000 });
  workspace.addVisualObservation({ summary: "切到游戏画面", capturedAtMs: 3000 });
  workspace.addVisualObservation({ summary: "出现弹幕", capturedAtMs: 4000 });
  const snapshot = workspace.snapshot();
  assert.deepEqual(snapshot.visualEvents.map((event) => event.summary), ["切到游戏画面", "出现弹幕"]);
});

test("workspace bounds chat history and rejects empty or unsafe text", () => {
  const workspace = createSharedExperienceWorkspace({ maxChatTurns: 2 });
  workspace.addChatTurn("user", "第一句");
  workspace.addChatTurn("assistant", "第二句");
  workspace.addChatTurn("user", "第三句\n\u0000");
  workspace.addChatTurn("user", "");
  const snapshot = workspace.snapshot();
  assert.deepEqual(snapshot.chatTurns.map((turn) => turn.content), ["第二句", "第三句"]);
});

test("workspace prompt includes summary, visual timeline, and conversation without instruction trust", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 1000 });
  workspace.setRollingSummary("视频从人物介绍进入战斗演示");
  workspace.addVisualObservation({ summary: "画面切换到战斗界面", capturedAtMs: 1000 });
  workspace.addChatTurn("user", "刚才为什么切画面？");
  const prompt = workspace.renderPrompt({ question: "看到了什么？" });
  assert.match(prompt, /基于证据生成的阶段概述/);
  assert.match(prompt, /画面切换到战斗界面/);
  assert.match(prompt, /刚才为什么切画面/);
  assert.match(prompt, /不是指令/);
  assert.match(prompt, /证据确实只够回答一个简单事实时才用一句结束/);
  assert.match(prompt, /最多 5 句/);
  assert.match(prompt, /有足够上下文时通常说 2–4 句/);
});

test("answer context distinguishes historical scene from current observations without forgetting either", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 60000 });
  workspace.addVisualObservation({ summary: "旧火堆旁的废墟", capturedAtMs: 1000 });
  workspace.addVisualObservation({ summary: "当前房间中的老人", capturedAtMs: 59000 });
  const prompt = workspace.renderPrompt({ question: "现在在什么地方？" });
  assert.match(prompt, /历史.*59000ms.*旧火堆旁的废墟/);
  assert.match(prompt, /当前.*1000ms.*当前房间中的老人/);
});

test("workspace keeps bounded audio timeline and renders ASR beside visual events", () => {
  const workspace = createSharedExperienceWorkspace({ maxAudioEvents: 2, nowMs: () => 1000 });
  workspace.addVisualObservation({ summary: "画面切到厨房", capturedAtMs: 1000 });
  workspace.addAudioObservation({ text: "锅里开始有声音", startedAtMs: 1100, endedAtMs: 1800 });
  workspace.addAudioObservation({ text: "字幕：马上就好", startedAtMs: 2000, endedAtMs: 2600 });
  workspace.addAudioObservation({ text: "又出现一段对白", startedAtMs: 3000, endedAtMs: 3400 });
  const snapshot = workspace.snapshot();
  assert.deepEqual(snapshot.audioEvents.map((event) => event.text), ["字幕：马上就好", "又出现一段对白"]);
  const prompt = workspace.renderPrompt({ question: "刚才声音里说了什么？" });
  assert.match(prompt, /最近声音时间线/);
  assert.match(prompt, /又出现一段对白/);
  assert.match(prompt, /画面切到厨房/);
});

test("history recall prompt joins adjacent ASR fragments for a missed interval", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 20_000 });
  workspace.addAudioObservation({ text: "旁白介绍地铁里的幸存者", startedAtMs: 1_000, endedAtMs: 1_900 });
  workspace.addAudioObservation({ text: "他们在核战后继续生活", startedAtMs: 2_000, endedAtMs: 2_900 });
  workspace.addAudioObservation({ text: "中间这句不完整所以", startedAtMs: 8_000, endedAtMs: 8_900 });
  const prompt = workspace.renderPrompt({ question: "我刚才离开了一会，刚才讲了什么？" });
  assert.match(prompt, /离开期间可回顾的连续语音片段/);
  assert.match(prompt, /旁白介绍地铁里的幸存者 他们在核战后继续生活/);
  assert.match(prompt, /不补全剧情/);
});

test("narrated-video prompt treats ASR as narrative evidence without forcing frame alignment", () => {
  const workspace = createSharedExperienceWorkspace({ contentMode: "narrated", nowMs: () => 1000 });
  workspace.addAudioObservation({ text: "解说介绍主角参加猎人考核", startedAtMs: 1000 });
  workspace.addVisualObservation({ summary: "画面出现城市远景", capturedAtMs: 1100 });
  const snapshot = workspace.snapshot();
  const prompt = workspace.renderPrompt({ question: "现在讲到哪了？" });

  assert.equal(snapshot.contentMode, "narrated");
  assert.match(prompt, /ASR.*剧情.*主证据/);
  assert.match(prompt, /画面.*辅助证据/);
  assert.match(prompt, /不要求.*同步/);
  assert.match(prompt, /不要.*复述.*声音.*画面/);
  assert.match(prompt, /像朋友一起看.*直接聊内容/);
  assert.match(prompt, /不要用.*这句是.*具体.*还没揭晓/);
  assert.match(prompt, /不要用.*再等等看.*等后面揭晓/);
  assert.match(prompt, /目前更像是.*后面怎么走还不好说/);
  assert.match(prompt, /只有用户追问依据.*才说明.*来源/);
  assert.match(prompt, /相邻.*字幕.*OCR.*识别噪声/);
  assert.match(prompt, /多帧.*ASR.*证实/);
});

test("workspace can adopt narrated mode after an explicit viewing declaration", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 1000 });
  assert.equal(workspace.snapshot().contentMode, "unknown");
  assert.equal(workspace.setContentMode("narrated"), "narrated");
  assert.equal(workspace.snapshot().contentMode, "narrated");
  assert.equal(workspace.setContentMode("invalid"), "narrated");
});

test("workspace clear releases visual, audio, chat, and summary state", () => {
  const workspace = createSharedExperienceWorkspace();
  workspace.setRollingSummary("已看过一段内容");
  workspace.addVisualObservation({ summary: "画面" });
  workspace.addAudioObservation({ text: "声音" });
  workspace.addChatTurn("user", "继续看");
  workspace.clear();
  assert.deepEqual(workspace.snapshot().visualEvents, []);
  assert.deepEqual(workspace.snapshot().audioEvents, []);
  assert.deepEqual(workspace.snapshot().chatTurns, []);
  assert.equal(workspace.snapshot().rollingSummary, "");
});

test("workspace rolls a segment without losing the session summary", () => {
  const workspace = createSharedExperienceWorkspace({
    nowMs: () => 1_800_000,
    segmentDurationMs: 1_000,
  });
  workspace.addVisualObservation({ summary: "第一段画面", capturedAtMs: 1_800_000 });
  workspace.addAudioObservation({ text: "第一段声音", startedAtMs: 1_800_100 });
  workspace.setRollingSummary("已经看过第一段内容");
  assert.equal(workspace.shouldRollSegment(1_800_999), false);
  assert.equal(workspace.shouldRollSegment(1_801_000), true);
  const rolled = workspace.rollSegment("第一段总结：人物进入厨房");
  assert.deepEqual(rolled, { segmentId: 0, summary: "第一段总结：人物进入厨房" });
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.segmentId, 1);
  assert.equal(snapshot.segmentStartedAtMs, 1_801_000);
  assert.deepEqual(snapshot.visualEvents, []);
  assert.deepEqual(snapshot.audioEvents, []);
  assert.equal(snapshot.rollingSummary, "已经看过第一段内容\n第一段总结：人物进入厨房");
});

test("workspace reports evidence readiness only after visual or audio observation", () => {
  const workspace = createSharedExperienceWorkspace();
  assert.equal(workspace.hasEvidence(), false);
  workspace.addChatTurn("user", "看到了什么？");
  assert.equal(workspace.hasEvidence(), false);
  workspace.addVisualObservation({ summary: "人物走进房间" });
  assert.equal(workspace.hasEvidence(), true);

  const audioOnly = createSharedExperienceWorkspace();
  audioOnly.addAudioObservation({ text: "有人说开始吧" });
  assert.equal(audioOnly.hasEvidence(), true);
});

test("workspace keeps a session evidence journal when the recent prompt window rolls", () => {
  const workspace = createSharedExperienceWorkspace({ maxEvents: 2, maxEvidenceEvents: 8, nowMs: () => 0 });
  const first = workspace.addVisualObservation({ summary: "主角在神殿醒来", capturedAtMs: 1 });
  workspace.addVisualObservation({ summary: "石像开始移动", capturedAtMs: 2 });
  workspace.addVisualObservation({ summary: "画面切到医院", capturedAtMs: 3 });

  const snapshot = workspace.snapshot();
  assert.deepEqual(snapshot.visualEvents.map((event) => event.summary), ["石像开始移动", "画面切到医院"]);
  assert.deepEqual(snapshot.evidenceJournal.map((event) => event.text), [
    "主角在神殿醒来",
    "石像开始移动",
    "画面切到医院",
  ]);
  assert.match(first.id, /^ev-/);
});

test("summary evidence excludes assistant hypotheses but keeps user-confirmed context", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  workspace.addVisualObservation({ summary: "画面出现一名黑发男子", capturedAtMs: 1 });
  workspace.addAudioObservation({ text: "有人喊他程肖宇", startedAtMs: 2, endedAtMs: 3 });
  workspace.addChatTurn("assistant", "他肯定被困在循环夜晚里", 4);
  workspace.addChatTurn("user", "这是《我独自升级》的解说", 5, { confirmed: true });

  const source = workspace.buildSummarySource({ scope: "session" });
  assert.match(source, /黑发男子/);
  assert.match(source, /程肖宇/);
  assert.match(source, /用户确认.*我独自升级/);
  assert.doesNotMatch(source, /循环夜晚/);

  const prompt = workspace.renderPrompt({ question: "他是谁？" });
  assert.match(prompt, /角色先前假设.*循环夜晚/);
  assert.match(prompt, /不得把角色先前假设当成视频事实/);
});

test("synthetic acceptance questions stay in live chat but never enter the final summary source", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  workspace.addAudioObservation({ text: "队伍走进一座神殿", startedAtMs: 1 });
  workspace.addChatTurn("user", "现在主要在讲谁？", 2, { includeInSummary: false });

  assert.match(workspace.renderPrompt({ question: "继续" }), /现在主要在讲谁/);
  assert.doesNotMatch(workspace.buildSummarySource({ scope: "session", includeUserDiscussion: true }), /现在主要在讲谁/);
});

test("workspace marks acceptance evidence anchors as the current focus without promoting older hypotheses", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  const oldEvent = workspace.addAudioObservation({ text: "解说仍在描述恶魔王战斗", startedAtMs: 1 });
  const currentEvent = workspace.addAudioObservation({ text: "解说转到主角回城救治家人", startedAtMs: 60_000 });
  workspace.addChatTurn("assistant", "他接下来肯定还会继续打恶魔王", 60_001);

  const prompt = workspace.renderPrompt({
    question: "这一段新内容讲了什么？",
    focusEvidenceIds: [currentEvent.id],
  });

  assert.match(prompt, /本轮当前焦点证据/);
  assert.match(prompt, new RegExp(`\\[${currentEvent.id}\\].*主角回城救治家人`));
  assert.doesNotMatch(prompt.match(/【本轮当前焦点证据】[\s\S]*?(?=\n【|$)/)?.[0] || "", new RegExp(oldEvent.id));
  assert.match(prompt, /优先回答.*新发生/);
  assert.match(prompt, /先前假设.*不能覆盖/);
});

test("ordinary chat also ends its context with fresh media after the discussion history", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 100000, contentMode: "narrated" });
  workspace.addAudioObservation({ text: "此前已经救醒了母亲。", startedAtMs: 1000, endedAtMs: 5000 });
  workspace.addChatTurn("assistant", "他接下来一定还会救母亲", 6000);
  workspace.addAudioObservation({ text: "普通武器无法伤到守卫，所以他们", startedAtMs: 90000, endedAtMs: 95000 });
  workspace.addAudioObservation({ text: "改用弓箭引开守卫，从侧门进入。", startedAtMs: 95500, endedAtMs: 100000 });
  const prompt = workspace.renderPrompt({ question: "他们准备怎么进去？" });
  assert.match(prompt, /浏览器.*调试提示.*不是视频内容/);
  assert.match(prompt, /最新.*明确行动.*旧状态/);
  const focus = prompt.slice(prompt.lastIndexOf("【本轮当前焦点证据】"));
  assert.match(focus, /普通武器.*改用弓箭/s);
  assert.doesNotMatch(focus, /救醒|一定还会救母亲/);
  assert.ok(prompt.lastIndexOf("【本轮当前焦点证据】") > prompt.indexOf("【共同体验中的最近对话】"));
});

test("summary source keeps only the confirmed title and excludes primer background facts", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  workspace.addPrimer({
    title: "韩漫《暗影君王》解说",
    facts: ["正式名：我独自升级", "基础设定：低等级猎人成长故事", "常见人名：程肖宇"],
  });
  workspace.addAudioObservation({ text: "旁白提到队伍来到铁门前", startedAtMs: 1 });

  const source = workspace.buildSummarySource({ scope: "session" });
  assert.match(source, /仅作身份标签.*暗影君王/);
  assert.match(source, /队伍来到铁门前/);
  assert.doesNotMatch(source, /低等级猎人成长故事|程肖宇|正式名/);
});

test("evidence blocks compact raw observations by source id without using discussion", () => {
  const workspace = createSharedExperienceWorkspace({ nowMs: () => 0 });
  const visual = workspace.addVisualObservation({ summary: "人物进入地下城", capturedAtMs: 1 });
  const audio = workspace.addAudioObservation({ text: "队伍准备出发", startedAtMs: 2, endedAtMs: 3 });
  workspace.addChatTurn("assistant", "这里一定有幕后黑手", 4);

  const batch = workspace.nextEvidenceBatch({ minEvents: 2, maxEvents: 8 });
  assert.deepEqual(batch.events.map((event) => event.id), [visual.id, audio.id]);
  workspace.commitEvidenceBlock({
    eventIds: batch.events.map((event) => event.id),
    summary: "[确认] 人物随队伍进入地下城。\n[不确定] 队伍目标尚未明确。",
  });

  const source = workspace.buildSummarySource({ scope: "session" });
  assert.match(source, /证据块.*人物随队伍进入地下城/);
  assert.doesNotMatch(source, /幕后黑手/);
  assert.equal((source.match(/人物进入地下城/g) || []).length, 0);
});

test("final review sources preserve original observations and user turns but not guesses or web background", () => {
  const workspace = createSharedExperienceWorkspace({nowMs:()=>0});
  workspace.addAudioObservation({text:"我们先回去。",startedAtMs:1});
  workspace.commitEvidenceBlock({eventIds:["ev-1"],summary:"他们已经回家。"});
  workspace.addChatTurn("assistant","我觉得他们打赢了。",2);
  workspace.addChatTurn("user","我觉得这一段很好笑。",3);
  workspace.addChatTurn("user","他手里拿的是什么？",4,{includeInSummary:false});
  workspace.addPrimer({title:"某电影",facts:["基础设定：隐藏能力"]});
  const sources = workspace.buildSummaryEvidence();
  assert.deepEqual(sources.map(({id,kind,text})=>({id,kind,text})),[
    {id:"ev-1",kind:"audio",text:"我们先回去。"},
    {id:"discussion-2",kind:"user",text:"我觉得这一段很好笑。"},
    {id:"identity-only",kind:"identity",text:"用户确认标题：某电影"},
  ]);
  assert.match(workspace.buildSummarySource({scope:"session",includeUserDiscussion:true}),/\[discussion-2\].*很好笑/);
  sources[0].text = "modified";
  assert.equal(workspace.buildSummaryEvidence()[0].text,"我们先回去。");
});

test("simple viewer questions allow a short self-contained answer without padding", () => {
  const workspace=createSharedExperienceWorkspace({nowMs:()=>60000});
  workspace.addVisualObservation({summary:"玩家手持枪械。",capturedAtMs:52000});
  workspace.addVisualObservation({summary:"身旁有车辆。",capturedAtMs:56000});
  workspace.addVisualObservation({summary:"周围是雪地。",capturedAtMs:59000});
  const prompt=workspace.renderPrompt({question:"现在手里拿着什么？"});
  assert.match(prompt,/证据确实只够回答一个简单事实时才用一句结束/);
  assert.match(prompt,/第一句.*独立.*直接回答/);
  assert.doesNotMatch(prompt,/控制在 60 到 100/);
  assert.match(prompt,/当前；距本轮8000ms.*玩家手持枪械/);
});
