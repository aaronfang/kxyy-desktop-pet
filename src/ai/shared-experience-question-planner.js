import { isQuestionEvidenceUsable } from "./shared-experience-evidence-window.js";

const MAX_QUOTE_CHARS = 72;
const MIN_PRIMARY_EVIDENCE_ADVANCE_MS = 30_000;

function clean(value, maxChars = MAX_QUOTE_CHARS) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function journalFrom(snapshot) {
  const direct = snapshot?.evidenceJournal;
  const nested = snapshot?.workspace?.evidenceJournal;
  return (Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [])
    .filter((event) => event && ["visual", "audio"].includes(event.kind) && clean(event.text));
}

function isUsableEvidence(event) {
  return isQuestionEvidenceUsable(event);
}

function evidenceTheme(event) {
  const text = clean(event?.text);
  if (/世界|设定|传送门|地下城|魔物|等级|职业|能力|规则|灾难/u.test(text)) return "setting";
  if (/主角|男子|女子|男人|女人|男孩|女孩|猎人|队长|母亲|父亲|人物|他|她/u.test(text)) return "character";
  if (/进入|离开|攻击|战斗|逃|站|走|跑|拿|打开|发现|决定|受伤|医院/u.test(text)) return "action";
  return "event";
}

export function planEvidenceAnchoredQuestion({
  snapshot = {},
  elapsedMs = 0,
  turnIndex = 0,
  requestedCategory = "",
  usedPrimaryEventIds = [],
  lastPrimaryEvidenceAtMs = null,
} = {}) {
  const journal = journalFrom(snapshot);
  if (!journal.length) {
    return {
      prompt: "现在还没取得足够的画面或声音证据，我们先等等；请不要猜剧情。",
      category: "waiting",
      maturity: "waiting",
      anchorEventIds: [],
    };
  }

  const recent = journal.slice(-8).filter(isUsableEvidence);
  if (!recent.length) {
    return {
      prompt: "这一段信息还比较零碎，我们先看看接下来发生什么。",
      category: "waiting",
      maturity: "waiting",
      anchorEventIds: [],
    };
  }
  const narrated = snapshot?.contentMode === "narrated" || snapshot?.workspace?.contentMode === "narrated";
  const usedIds = new Set(Array.isArray(usedPrimaryEventIds) ? usedPrimaryEventIds : []);
  const lastPrimaryAt = Number(lastPrimaryEvidenceAtMs);
  const hasPreviousPrimaryAt = lastPrimaryEvidenceAtMs !== null
    && lastPrimaryEvidenceAtMs !== undefined
    && lastPrimaryEvidenceAtMs !== ""
    && Number.isFinite(lastPrimaryAt);
  const recentAudio = recent.filter((event) => event.kind === "audio");
  const primaryCandidates = narrated && recentAudio.length ? recentAudio : recent;
  const primary = [...primaryCandidates].reverse().find((event) => {
    if (usedIds.has(event.id)) return false;
    if (!hasPreviousPrimaryAt) return true;
    return Number(event.atMs) >= lastPrimaryAt + MIN_PRIMARY_EVIDENCE_ADVANCE_MS;
  });
  if (!primary) {
    return {
      prompt: "这段刚聊过了，等有新的画面或声音再接着聊。",
      category: "waiting",
      maturity: "waiting",
      anchorEventIds: [],
    };
  }
  const secondary = narrated
    ? recentAudio.filter((event) => event.id !== primary.id).at(-1)
    : recent.find((event) => event.id !== primary.id && event.kind !== primary.kind) || recent[Math.max(0, recent.length - 3)];
  const theme = evidenceTheme(primary);
  const evidenceBlocks = snapshot?.evidenceBlocks || snapshot?.workspace?.evidenceBlocks || [];
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const canConnect = elapsed >= 5 * 60_000 && journal.length >= 20;
  const canDiscussStory = elapsed >= 12 * 60_000 && journal.length >= 40 && evidenceBlocks.length >= 1;

  if (!canConnect) {
    const prompts = primary.kind === "visual"
      ? theme === "character"
        ? ["画面里的人现在在做什么？", "这个人物此刻有什么明显动作？", "这里最值得留意的是人物还是场景？"]
        : ["这帧能确认的场景或动作是什么？", "画面现在把重点放在哪里？", "这里出现了什么值得留意的东西？"]
      : theme === "setting"
        ? ["这段先交代了哪些世界观信息？", "这里建立了怎样的背景和规则？", "目前最关键的设定是什么？"]
        : theme === "character"
          ? ["现在主要在讲谁，他遇到了什么事？", "这个人物目前的处境怎么样？", "这里的人物关系有什么新信息？"]
          : ["这一段明确交代了什么？", "目前能确认的重点是什么？", "这段主要讲到哪件事？"];
    return {
      prompt: prompts[Math.abs(Number(turnIndex) || 0) % prompts.length],
      category: "evidence",
      maturity: "shallow",
      anchorEventIds: [primary.id],
      primaryEvidenceAtMs: Number(primary.atMs) || 0,
    };
  }

  const retrospectiveCategories = new Set(["continuity", "causal", "character", "discussion", "judgment", "checkpoint"]);
  const wantsRetrospective = retrospectiveCategories.has(String(requestedCategory || ""));
  const retrospectiveTurn = Math.abs(Number(turnIndex) || 0) % 4 === 0;
  const shouldRetrospect = canConnect && wantsRetrospective && retrospectiveTurn;

  if (!shouldRetrospect) {
    const prompts = primary.kind === "visual"
      ? theme === "character"
        ? ["画面里的人现在在做什么？", "这个人物此刻有什么明显动作？", "这里最值得留意的是人物还是场景？"]
        : ["这帧能确认的场景或动作是什么？", "画面现在把重点放在哪里？", "这里出现了什么值得留意的东西？"]
      : theme === "setting"
        ? ["这段新解说具体交代了什么设定？", "刚才这段声音里新增了哪条信息？", "这段讲到的重点是什么？"]
        : theme === "character"
          ? ["现在主要在讲谁，他刚遇到了什么事？", "这段新信息里人物正在面对什么？", "解说刚讲到的人物线索是什么？"]
          : ["这一段新内容明确交代了什么？", "刚才这段主要讲到哪件事？", "这里有什么新信息值得留意？"];
    return {
      prompt: prompts[Math.abs(Number(turnIndex) || 0) % prompts.length],
      category: "evidence",
      maturity: "shallow",
      anchorEventIds: [primary.id],
      primaryEvidenceAtMs: Number(primary.atMs) || 0,
    };
  }

  if (!canDiscussStory) {
    const prompt = theme === "setting"
      ? "这个新设定和前面发生的事是怎么连起来的？"
      : theme === "character"
        ? "和前面相比，这个人物的处境发生了什么变化？"
        : secondary
          ? "前后这两段内容是怎么发展过来的？"
          : "和前面相比，事情有了什么变化？";
    return {
      prompt,
      category: "continuity",
      maturity: "connecting",
      anchorEventIds: [...new Set([secondary?.id, primary.id].filter(Boolean))],
      primaryEvidenceAtMs: Number(primary.atMs) || 0,
    };
  }

  const storyPrompts = [
    "看到这里，主角的处境或目标发生了什么变化？",
    "把前后的事连起来看，你觉得关键转折在哪里？",
    "到目前为止，哪条因果关系已经比较清楚？",
    "看到这里，你觉得这段推进得怎么样？",
  ];
  return {
    prompt: storyPrompts[Math.abs(Number(turnIndex) || 0) % storyPrompts.length],
    category: "story",
    maturity: "story",
    anchorEventIds: [...new Set([secondary?.id, primary.id].filter(Boolean))],
    primaryEvidenceAtMs: Number(primary.atMs) || 0,
  };
}
