import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildMotifCooldownHint,
  buildRelationshipMoodHint,
  buildMessages,
  buildSystemPrompt,
  buildCompactSystemPrompt,
  buildOnlineAbstractSystemPrompt,
  FAMILIARITY_STAGE,
  applyFamiliaritySignal,
  familiarityStageFor,
  inferFamiliaritySignals,
  computeLiveContext,
  computeTemporalContextData,
  filterFewShotForConversationMode,
  hasExplicitLivestreamIntent,
  detectDeepIntent,
  detectShortTermConversationMood,
  getFollowupUserTrigger,
} from "../src/ai/persona.js";

const LORE = {
  schedule: { open_time: "20:30 左右", close_time: "00:30 左右" },
  weekly_schedule: { rest_day: "周一" },
  live_show_flow: {
    stages: [{ name: "开场人气票" }, { name: "唱歌" }],
  },
  sunday_special: { name: "福袋", reward: "唇印照" },
};

const YUANYUAN_CARD = JSON.parse(fs.readFileSync(
  new URL("../persona-cards/kxyy-yuanyuan/persona-card.json", import.meta.url),
  "utf8",
));

test("yuan yuan conversation prompts progressively add colloquial familiarity and bounded teasing", () => {
  const assets = {
    systemPrompt: "persona",
    activeCardId: "kxyy-yuanyuan",
    displayName: "开心元元",
    identity: { name: "开心元元", personality_tags: ["自然"] },
  };
  for (const prompt of [
    buildSystemPrompt(assets, { name: "ππ", useUserProfile: false }),
    buildCompactSystemPrompt(assets, { name: "ππ" }),
    buildOnlineAbstractSystemPrompt(assets, { name: "ππ" }),
  ]) {
    assert.match(prompt, /熟悉感是渐进的/);
    assert.match(prompt, /不要一味附和/);
    assert.match(prompt, /调侃要针对当下内容/);
  }

  const generic = buildCompactSystemPrompt({
    systemPrompt: "persona",
    activeCardId: "generic-card",
    displayName: "普通角色",
    identity: { name: "普通角色", personality_tags: ["克制"] },
  }, { name: "用户" });
  assert.doesNotMatch(generic, /熟悉感是渐进的/);
});

test("familiarity advances from explicit engagement evidence, not hidden turn count", () => {
  assert.equal(familiarityStageFor([]), FAMILIARITY_STAGE.NEW);
  assert.equal(familiarityStageFor(["user_shared_personal_detail"]), FAMILIARITY_STAGE.WARMING);
  assert.equal(familiarityStageFor([
    "user_shared_personal_detail",
    "user_recalled_shared_topic",
    "user_accepted_tease",
  ]), FAMILIARITY_STAGE.FAMILIAR);
  assert.equal(familiarityStageFor(Array(20).fill("ordinary_turn")), FAMILIARITY_STAGE.NEW);
});

test("explicit boundary feedback immediately reduces familiarity and blocks teasing", () => {
  let state = applyFamiliaritySignal({}, "user_shared_personal_detail");
  state = applyFamiliaritySignal(state, "user_accepted_tease");
  assert.equal(state.stage, FAMILIARITY_STAGE.WARMING);
  state = applyFamiliaritySignal(state, "user_rejected_nickname");
  assert.equal(state.stage, FAMILIARITY_STAGE.NEW);
  assert.equal(state.teasing, "off");
  assert.equal(state.evidence, 0);
});

test("familiarity inference uses explicit conversational signals and ignores ordinary turns", () => {
  const signals = inferFamiliaritySignals([
    { role: "user", content: "嗯" },
    { role: "user", content: "你还记得我上次说的那个项目吗" },
    { role: "user", content: "你又逗我，真会啊" },
    { role: "user", content: "别这么叫，认真点" },
  ]);
  assert.deepEqual(signals, [
    "user_recalled_shared_topic",
    "user_initiated_tease",
    "user_requested_formality",
  ]);
  const hint = buildRelationshipMoodHint(null, "neutral", [
    { role: "user", content: "我最近在做一个自己的项目，挺忙的" },
    { role: "user", content: "你还记得吗" },
  ]);
  assert.match(hint, /当前会话熟悉度表现层/);
});

test("daily context carries exact local time and timezone without inferred livestream state", () => {
  const context = computeLiveContext(
    new Date(2026, 6, 29, 21, 7, 0),
    LORE,
    "kxyy-yuanyuan",
    { timeZone: "Asia/Shanghai" },
  );
  assert.match(context, /2026年7月29日/);
  assert.match(context, /周三 21:07/);
  assert.match(context, /Asia\/Shanghai/);
  assert.match(context, /日常私聊/);
  assert.doesNotMatch(context, /正在直播|直播间|开播|下播|倒计时|福袋|礼物/);
});

test("livestream intent is explicit and does not trigger on ordinary daily chat", () => {
  const cases = [
    ["今天吃什么呀", false],
    ["最近心情怎么样", false],
    ["你今晚开播吗", true],
    ["直播间那个妆造挺好看", true],
    ["上次PK之后发生啥了", true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(hasExplicitLivestreamIntent(text), expected, text);
  }
});

test("explicit livestream turns receive bounded lore without a fabricated current status", () => {
  const messages = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [{ role: "user", content: "你今晚开播吗" }],
    maxTurns: 4,
    useLive: true,
    lore: LORE,
    cardId: "kxyy-yuanyuan",
    now: new Date(2026, 6, 29, 21, 7, 0),
    timeZone: "Asia/Shanghai",
  });
  const runtime = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(runtime, /20:30 左右/);
  assert.match(runtime, /开场人气票/);
  assert.match(runtime, /不能据此判断当前是否在工作/);
  assert.doesNotMatch(runtime, /正在直播|已开播 \d|距现在还有|候播期/);
});

test("ordinary turns do not receive livestream lore", () => {
  const messages = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [{ role: "user", content: "今天过得咋样" }],
    maxTurns: 4,
    useLive: true,
    lore: LORE,
    cardId: "kxyy-yuanyuan",
    now: new Date(2026, 6, 29, 21, 7, 0),
    timeZone: "Asia/Shanghai",
  });
  const runtime = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.doesNotMatch(runtime, /20:30|开场人气票|直播间|福袋/);
});

test("daily turns filter livestream-derived few-shot pairs but explicit turns retain them", () => {
  const fewShot = [
    { role: "user", content: "今天吃啥" },
    { role: "assistant", content: "还没想好呢，你呢？" },
    { role: "user", content: "几点开播" },
    { role: "assistant", content: "通常八点半左右，临时安排不一定。" },
  ];
  const daily = filterFewShotForConversationMode(fewShot, {
    isKxyy: true,
    includeLivestream: false,
  });
  assert.equal(daily.length, 2);
  assert.doesNotMatch(daily.map((item) => item.content).join("\n"), /开播/);
  assert.equal(filterFewShotForConversationMode(fewShot, {
    isKxyy: true,
    includeLivestream: true,
  }).length, 4);
});

test("proactive daily prompts contain no livestream-room topic seeds", () => {
  for (const proactiveKind of ["welcome", "comeback", "idle"]) {
    const messages = buildMessages({
      systemPrompt: "persona",
      fewShot: [],
      history: [],
      maxTurns: 4,
      useLive: true,
      lore: LORE,
      cardId: "kxyy-yuanyuan",
      proactiveKind,
      now: new Date(2026, 6, 29, 21, 7, 0),
      timeZone: "Asia/Shanghai",
    });
    const prompt = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    assert.doesNotMatch(prompt, /直播间|开播|下播|福袋|礼物|人气票|弹幕/, proactiveKind);
  }
});

test("follow-up request ends with an explicit user-role continuation directive", () => {
  const trigger = getFollowupUserTrigger();
  const messages = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [
      { role: "user", content: "你不是买了一把按摩椅吗" },
      { role: "assistant", content: "那玩意那么贵，我就用了一两次。" },
      { role: "user", content: trigger },
    ],
    maxTurns: 4,
    useLive: false,
    lore: {},
    cardId: "kxyy-yuanyuan",
    proactiveKind: "followup",
  });
  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.content, trigger);
  assert.match(messages.at(-1)?.content || "", /由你再顺口补一句/);
});

test("completed follow-up hides its old directive without corrupting role order", () => {
  const trigger = getFollowupUserTrigger();
  const messages = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [
      { role: "user", content: "按摩椅后来怎么样了" },
      { role: "assistant", content: "后来我把它挪到角落了。" },
      { role: "user", content: trigger },
      { role: "assistant", content: "现在主要拿来放衣服。" },
      { role: "user", content: "那确实挺真实" },
    ],
    maxTurns: 6,
    useLive: false,
    lore: {},
    cardId: "kxyy-yuanyuan",
  });
  const conversational = messages.filter((message) => message.role !== "system");
  assert.deepEqual(conversational.map((message) => message.role), [
    "user",
    "assistant",
    "user",
  ]);
  assert.match(conversational[1].content, /挪到角落.*放衣服/s);
  assert.doesNotMatch(JSON.stringify(messages), /由你再顺口补一句/);

  const assistantTrigger = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [
      { role: "user", content: "复述一下" },
      { role: "assistant", content: trigger },
    ],
    maxTurns: 2,
    useLive: false,
    lore: {},
    cardId: "kxyy-yuanyuan",
  });
  assert.equal(assistantTrigger.at(-1)?.content, trigger);
});

test("motif cooldown is bounded to recent session replies and yields to explicit user topics", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: "assistant",
    content: index === 10 ? "我想吃火锅鸡" : index === 11 ? "上次开播挺忙" : `普通回复${index}`,
  }));
  const hint = buildMotifCooldownHint(history, "你今天想聊啥");
  assert.match(hint, /火锅鸡/);
  assert.match(hint, /主播工作梗/);
  assert.doesNotMatch(buildMotifCooldownHint(history, "火锅鸡到底好吃不"), /“火锅鸡”/);
  assert.doesNotMatch(buildMotifCooldownHint(history, "你啥时候开播"), /主播工作梗/);
  assert.equal(buildMotifCooldownHint(history.slice(0, 8), "随便聊聊"), "");
});

test("bundled YuanYuan card defaults to daily chat and preserves epistemic boundaries", () => {
  const prompt = YUANYUAN_CARD.system_prompt;
  assert.equal(YUANYUAN_CARD.meta.version, "1.1.0");
  assert.match(prompt, /朋友式日常私聊/);
  assert.match(prompt, /当前饭菜、行程、穿着、身边人物/);
  assert.match(prompt, /火锅鸡也只是其中一种偏好/);
  assert.match(prompt, /不是弹幕/);
  assert.doesNotMatch(prompt, /像正在直播一样回应|开始接待直播间|每条用户消息都是一条粉丝弹幕/);
  assert.ok((prompt.match(/直播/g) || []).length <= 3);
  const firstReply = YUANYUAN_CARD.few_shot[1]?.content || "";
  assert.match(firstReply, /不能现编/);
  assert.doesNotMatch(firstReply, /我.*吃了/);
});

test("temporal payload refreshes per turn without carrying weather or activity", () => {
  const first = computeTemporalContextData(new Date(2026, 6, 29, 21, 7), "Asia/Shanghai");
  const second = computeTemporalContextData(new Date(2026, 6, 29, 21, 8), "Asia/Shanghai");
  assert.deepEqual(first, {
    date: "2026-07-29",
    weekday: "周三",
    time: "21:07",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(second.time, "21:08");
  assert.deepEqual(Object.keys(second).sort(), ["date", "time", "timeZone", "weekday"].sort());
});

test("deep intent accepts long concrete personal expression and rejects non-conversation blobs", () => {
  const cases = [
    ["我最近换了工作，本来以为自己会轻松一点，但是每天到了晚上还是很焦虑，总觉得是不是选错了，又不知道能跟谁说。", true],
    ["这阵子家里事情一件接一件，我其实一直忍着没说，今天突然觉得特别累，也不知道这样撑着到底有没有意义。", true],
    ["你怎么看待朋友之间慢慢疏远这件事", true],
    ["请按照下面的接口定义实现全部功能，并输出完整代码和测试用例，要求覆盖所有异常分支以及性能边界。", false],
    ["https://example.com/very/long/article?with=many&query=params 请分析这个网页并详细说说里面的全部内容。", false],
    ["```js\nconst value = { nested: true, message: '我最近很烦但是这是测试数据' };\nfunction run() { return value; }\n```", false],
    ["【图片内容】一个人站在窗边，画面里有很多文字，详细说说你怎么看。", false],
  ];
  for (const [text, expected] of cases) assert.equal(detectDeepIntent(text), expected, text);
});

test("conversation prompts preserve persona agency and support a longer listening mode", () => {
  const ordinary = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [{ role: "user", content: "我最近有点迷茫" }],
    maxTurns: 4,
    useLive: false,
    lore: {},
    cardId: "kxyy-yuanyuan",
  });
  const ordinaryPrompt = ordinary.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(ordinaryPrompt, /不要把“我懂”/);
  assert.match(ordinaryPrompt, /温和反驳/);

  const deep = buildMessages({
    systemPrompt: "persona",
    fewShot: [],
    history: [{ role: "user", content: "你能再多说一点吗？我有的时候也不知道想说什么" }],
    maxTurns: 4,
    useLive: false,
    lore: {},
    cardId: "kxyy-yuanyuan",
    deep: true,
  });
  const deepPrompt = deep.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(deepPrompt, /连续讲 3~6 段/);
  assert.match(deepPrompt, /不必每段都问问题/);
});

test("relationship and short-term mood only modulate allowlisted presentation", () => {
  assert.equal(detectShortTermConversationMood("我今天有点难受，心里堵得慌"), "low");
  assert.equal(detectShortTermConversationMood("哈哈哈今天太开心了"), "bright");
  assert.equal(detectShortTermConversationMood("普通聊两句"), "neutral");
  const hint = buildRelationshipMoodHint({
    relationship_with_yuan: { type: "认识很久的朋友" },
    ai_should_treat_me_as: "熟人私聊",
  }, "low");
  assert.match(hint, /称呼、语气、主动性、动作和 SpeechStyle/);
  assert.match(hint, /认识很久的朋友/);
  assert.match(hint, /语气放轻/);
  assert.match(hint, /禁止据此新增、删除或改写任何 persona\/system 事实/);
  assert.match(hint, /禁止推导隐藏好感度、恋爱关系或新的长期记忆/);
  assert.equal(buildRelationshipMoodHint(null, "unknown"), "");
});
