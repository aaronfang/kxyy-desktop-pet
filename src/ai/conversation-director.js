export const CONVERSATION_MOVE = Object.freeze({
  EXPAND: "expand",
  OFFER_ENTRY: "offer-entry",
  DEEPEN: "deepen",
  ASSOCIATE: "associate",
});

export const RESPONSE_CUE = Object.freeze({
  NONE: "none",
  LOW_BURDEN: "low-burden",
  QUESTION: "question",
});

const DEFAULT_DELAYS = Object.freeze({
  statement: 4000,
  lowBurden: 6000,
  question: 8000,
  topicSwitch: 14000,
});

const LOW_INTEREST_POLICIES = new Set(["acknowledge"]);
const POSITIVE_ENGAGEMENT_POLICIES = new Set(["amused", "curious", "agree"]);
const LATERAL_ELIGIBLE_POLICIES = new Set([
  "substantive",
  "acknowledge",
  "amused",
  "curious",
  "agree",
]);
const LATERAL_TURN_INTERVAL = 4;
const MISSED_WINDOW_THRESHOLD = 3;
const LATERAL_COOLDOWN_TURNS = 5;
const TOPIC_ACTIVITY = new Set(["active", "neutral", "settling", "sensitive"]);
const SOFT_INTENTS = new Set([
  "none",
  "invite-opinion",
  "invite-advice",
  "deepen",
  "lighten",
  "concretize",
]);
const IMPORTANT_TOPIC_CATEGORIES = new Set([
  "emotion",
  "decision",
  "goal",
  "relationship",
  "long-running",
]);
const FIRST_PERSON_RE = /我|我的|我们|自己/;
const DECISION_RE = /(?:还没|没有|没)决定|不(?:知道|确定)(?:该不该|要不要|怎么选)|(?:该不该|要不要).{0,12}(?:纠结|犹豫)|纠结.{0,12}(?:选择|决定|要不要|该不该)|犹豫.{0,12}(?:选择|决定|要不要|该不该)/;
const GOAL_RE = /(?:我的|今年|最近|接下来|以后).{0,8}(?:目标|计划)|我(?:一直)?(?:希望|打算|准备|正在努力).{2,40}(?:完成|做到|实现|成为|学会|做出|改善|坚持)|我.{0,8}(?:目标|计划)(?:是|就是)/;
const RELATIONSHIP_RE = /我(?:和|跟).{0,12}(?:家人|家里人|父母|爸妈|妈妈|爸爸|朋友|伴侣|对象|爱人|同事|室友).{0,24}(?:关系|矛盾|冲突|疏远|难受|困扰|在意|担心)|(?:家人|家里人|父母|爸妈|妈妈|爸爸|朋友|伴侣|对象|爱人|同事|室友).{0,12}(?:和我的关系|让我.{0,6}(?:难受|困扰|在意|担心))/;
const EMOTION_RE = /(?:焦虑|难受|委屈|害怕|担心|失落|孤独|压抑|内疚|愧疚|迷茫|崩溃|痛苦|烦躁|不安|很开心|特别开心|很期待|特别期待)/;
const LONG_RUNNING_RE = /(?:一直|长期|反复|好多年|好几年|几个月|很久).{0,18}(?:困扰|烦恼|问题|放不下|过不去|没解决)|(?:困扰|烦恼|问题|放不下|过不去|没解决).{0,18}(?:一直|长期|反复|好多年|好几年|几个月|很久)/;

function normalizeMode(value) {
  return value === "ai-leads" || value === "balanced" ? value : "follow-user";
}

function normalizeDelays(value) {
  const input = value && typeof value === "object" ? value : {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_DELAYS)) {
    const candidate = Number(input[key]);
    result[key] = Number.isFinite(candidate) ? Math.max(0, candidate) : fallback;
  }
  return result;
}

function responseDelay(plan, delays) {
  if (plan?.responseCue === RESPONSE_CUE.QUESTION) return delays.question;
  if (plan?.responseCue === RESPONSE_CUE.LOW_BURDEN) return delays.lowBurden;
  return delays.statement;
}

function topicBigrams(value) {
  const chars = Array.from(String(value || ""));
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) => char + chars[index + 1]));
}

function relatedTopicKeys(left, right) {
  if (left === right) return true;
  if (!/[\p{Script=Han}]/u.test(`${left}${right}`)) return false;
  const a = topicBigrams(left);
  const b = topicBigrams(right);
  if (!a.size || !b.size) return false;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  let overlap = 0;
  for (const token of smaller) if (larger.has(token)) overlap += 1;
  return overlap / smaller.size >= 0.3;
}

export function classifyImportantTopicBranch(text) {
  const value = String(text || "").trim();
  if (!value || !FIRST_PERSON_RE.test(value)) return "none";
  if (RELATIONSHIP_RE.test(value)) return "relationship";
  if (DECISION_RE.test(value)) return "decision";
  if (GOAL_RE.test(value)) return "goal";
  if (EMOTION_RE.test(value)) return "emotion";
  if (LONG_RUNNING_RE.test(value)) return "long-running";
  return "none";
}

class SessionTopicLedger {
  constructor({ maxEntries = 8, revisitEvery = 5 } = {}) {
    this.maxEntries = Math.max(1, Math.min(8, Number(maxEntries) || 8));
    this.revisitEvery = Math.max(1, Math.min(20, Number(revisitEvery) || 5));
    this.lifecycle = "active";
    this.entries = [];
    this.acceptedTransitions = 0;
  }

  observe({ topicKey, category, context } = {}) {
    if (this.lifecycle !== "active") return false;
    const key = Array.from(String(topicKey || "").trim()).slice(0, 64).join("");
    const safeCategory = IMPORTANT_TOPIC_CATEGORIES.has(category) ? category : "none";
    const safeContext = Array.from(String(context || "").trim()).slice(0, 160).join("");
    if (!key || safeCategory === "none" || !safeContext) return false;
    const existing = this.entries.find(
      (entry) => entry.topicKey === key ||
        (entry.category === safeCategory && relatedTopicKeys(entry.topicKey, key)),
    );
    if (existing) {
      existing.category = safeCategory;
      existing.context = safeContext;
      return true;
    }
    this.entries.push({
      topicKey: key,
      category: safeCategory,
      context: safeContext,
      sealed: false,
      revisited: false,
    });
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return true;
  }

  seal(topicKey) {
    if (this.lifecycle !== "active") return false;
    const key = String(topicKey || "").trim();
    const entry = this.entries.find((candidate) => candidate.topicKey === key);
    if (!entry) return false;
    entry.sealed = true;
    return true;
  }

  proposeTransition() {
    const transition = this.acceptedTransitions + 1;
    if (this.lifecycle !== "active" || transition % this.revisitEvery !== 0) {
      return { kind: "switch", transition };
    }
    const entry = this.entries.find((candidate) => !candidate.sealed && !candidate.revisited);
    if (!entry) return { kind: "switch", transition };
    return {
      kind: "revisit",
      transition,
      topicKey: entry.topicKey,
      category: entry.category,
      context: entry.context,
    };
  }

  commitTransition(proposal) {
    if (
      this.lifecycle !== "active" ||
      !proposal ||
      proposal.transition !== this.acceptedTransitions + 1
    ) return false;
    this.acceptedTransitions += 1;
    if (proposal.kind === "revisit") {
      const entry = this.entries.find(
        (candidate) => candidate.topicKey === proposal.topicKey && !candidate.sealed,
      );
      if (entry) entry.revisited = true;
    }
    return true;
  }

  snapshot() {
    if (this.lifecycle === "stopped") {
      return {
        lifecycle: "stopped",
        entries: 0,
        eligible: 0,
        revisited: 0,
        acceptedTransitions: 0,
      };
    }
    return {
      lifecycle: this.lifecycle,
      entries: this.entries.length,
      eligible: this.entries.filter((entry) => !entry.sealed && !entry.revisited).length,
      revisited: this.entries.filter((entry) => entry.revisited).length,
      acceptedTransitions: this.acceptedTransitions,
    };
  }

  stop() {
    this.lifecycle = "stopped";
    this.entries = [];
    this.acceptedTransitions = 0;
  }
}

export function createSessionTopicLedger(options = {}) {
  return new SessionTopicLedger(options);
}

class ConversationDirector {
  constructor({ mode, delays } = {}) {
    this.mode = normalizeMode(mode);
    this.delays = normalizeDelays(delays);
    this.lifecycle = "idle";
    this.paused = this.mode === "follow-user";
    this.proactiveTurns = 0;
    this.lowInterestTurns = 0;
    this.sameTopicContinuations = 0;
    this.lastMove = "none";
    this.lastResponseCue = RESPONSE_CUE.NONE;
    this.depth = 0;
    this.initiativeDebt = 0;
    this.topicTurns = 0;
    this.lateralMoves = 0;
    this.lateralRecoveryTurns = 0;
    this.lateralCooldownTurns = 0;
    this.topicActivity = { active: 0, neutral: 0, settling: 0, sensitive: 0 };
    this._nextQuestionMove = CONVERSATION_MOVE.OFFER_ENTRY;
  }

  dispatch(event) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") return [];
    if (this.lifecycle === "stopped" && event.type !== "session-started") return [];

    switch (event.type) {
      case "session-started":
        this.lifecycle = "active";
        this.paused = this.mode === "follow-user";
        return [];
      case "user-turn-final":
        return this._onUserTurn(event);
      case "proactive-window-missed":
        if (
          this.mode === "ai-leads" &&
          this.lifecycle === "active" &&
          !this.paused &&
          event.reason === "asr"
        ) {
          this.initiativeDebt = Math.min(MISSED_WINDOW_THRESHOLD, this.initiativeDebt + 1);
        }
        return [];
      case "playback-completed":
        return this._afterPlayback(event.plan);
      case "silence-deadline":
        return this._onSilenceDeadline(event.kind);
      case "proactive-accepted":
        this.proactiveTurns = Math.min(3, this.proactiveTurns + 1);
        if (event.kind === "followup") {
          this.sameTopicContinuations = Math.min(3, this.sameTopicContinuations + 1);
        } else if (event.kind === "idle") {
          this.lowInterestTurns = 0;
          this.sameTopicContinuations = 0;
          this.depth = 0;
          this.topicTurns = 0;
        }
        this.initiativeDebt = 0;
        return [];
      case "hard-control":
        return this._onHardControl(event.control);
      case "speech-candidate":
        return [{ type: "cancel-proactive" }];
      case "hangup":
        this._stop();
        return [{ type: "cancel-proactive" }];
      default:
        return [];
    }
  }

  snapshot() {
    return {
      mode: this.mode,
      lifecycle: this.lifecycle,
      paused: this.paused,
      proactiveTurns: this.proactiveTurns,
      lowInterestTurns: this.lowInterestTurns,
      sameTopicContinuations: this.sameTopicContinuations,
      lastMove: this.lastMove,
      lastResponseCue: this.lastResponseCue,
      depth: this.depth,
      initiativeDebt: this.initiativeDebt,
      topicTurns: this.topicTurns,
      lateralMoves: this.lateralMoves,
      lateralRecoveryTurns: this.lateralRecoveryTurns,
      lateralCooldownTurns: this.lateralCooldownTurns,
      topicActivity: { ...this.topicActivity },
    };
  }

  _onUserTurn(event) {
    if (this.lifecycle !== "active") return [];
    const policy = typeof event.policy === "string" ? event.policy : "substantive";
    const softIntent = SOFT_INTENTS.has(event.softIntent) ? event.softIntent : "none";
    const topicActivity = TOPIC_ACTIVITY.has(event.topicActivity)
      ? event.topicActivity
      : event.lateralAllowed === false ? "sensitive" : "neutral";
    this.topicActivity[topicActivity] = Math.min(255, this.topicActivity[topicActivity] + 1);
    this.proactiveTurns = 0;

    if (LOW_INTEREST_POLICIES.has(policy)) {
      this.lowInterestTurns = Math.min(2, this.lowInterestTurns + 1);
    } else if (policy === "substantive" || POSITIVE_ENGAGEMENT_POLICIES.has(policy)) {
      this.lowInterestTurns = 0;
      if (policy === "substantive") this.sameTopicContinuations = 0;
    }

    if (policy === "pause") return this._onHardControl("pause");
    if (policy === "redirect") return this._onHardControl("redirect");
    if (policy === "resume") this._onHardControl("resume");

    const lateralAllowed = event.lateralAllowed !== false;
    if (!lateralAllowed) {
      this.topicTurns = 0;
      this.lateralRecoveryTurns = 2;
    } else if (this.lateralRecoveryTurns > 0) {
      this.lateralRecoveryTurns -= 1;
    }
    const lateralRecovered = lateralAllowed && this.lateralRecoveryTurns === 0;
    const lateralEligible = lateralRecovered && LATERAL_ELIGIBLE_POLICIES.has(policy);
    if (lateralEligible && this.lateralCooldownTurns > 0) {
      this.lateralCooldownTurns -= 1;
    }
    if (lateralEligible) {
      this.topicTurns = Math.min(LATERAL_TURN_INTERVAL, this.topicTurns + 1);
    }
    const shouldAssociate =
      this.mode === "ai-leads" &&
      lateralRecovered &&
      softIntent === "none" &&
      lateralEligible &&
      topicActivity !== "active" &&
      this.lateralCooldownTurns === 0 &&
      (
        this.initiativeDebt >= MISSED_WINDOW_THRESHOLD ||
        this.topicTurns >= LATERAL_TURN_INTERVAL
      );
    const plan = shouldAssociate
      ? this._plan(
          CONVERSATION_MOVE.ASSOCIATE,
          RESPONSE_CUE.LOW_BURDEN,
          "companion",
          Math.min(2, this.depth),
        )
      : this._nextPlan(softIntent);
    if (shouldAssociate) {
      this.initiativeDebt = 0;
      this.topicTurns = 0;
      this.lateralRecoveryTurns = 0;
      this.lateralCooldownTurns = LATERAL_COOLDOWN_TURNS;
      this.lateralMoves = Math.min(255, this.lateralMoves + 1);
    }
    this._recordPlan(plan);
    if (policy === "substantive") this.depth = Math.min(5, this.depth + 1);
    return [{ type: "request-reply", kind: "response", plan }];
  }

  _nextPlan(softIntent = "none") {
    const depth = this.depth;
    if (softIntent === "invite-opinion") {
      return this._plan(CONVERSATION_MOVE.EXPAND, RESPONSE_CUE.NONE, "opinion", depth);
    }
    if (softIntent === "invite-advice") {
      return this._plan(CONVERSATION_MOVE.EXPAND, RESPONSE_CUE.NONE, "advice", depth);
    }
    if (softIntent === "deepen") {
      return this._plan(CONVERSATION_MOVE.DEEPEN, RESPONSE_CUE.NONE, "companion", depth);
    }
    if (softIntent === "concretize") {
      return this._plan(CONVERSATION_MOVE.EXPAND, RESPONSE_CUE.NONE, "concrete", depth);
    }
    if (softIntent === "lighten") {
      return this._plan(CONVERSATION_MOVE.EXPAND, RESPONSE_CUE.NONE, "light", Math.max(0, depth - 1));
    }

    if (this.lastResponseCue !== RESPONSE_CUE.NONE || this.lastMove === "none") {
      return this._plan(CONVERSATION_MOVE.EXPAND, RESPONSE_CUE.NONE, "companion", depth);
    }
    const questionMove = this._nextQuestionMove;
    this._nextQuestionMove = questionMove === CONVERSATION_MOVE.OFFER_ENTRY
      ? CONVERSATION_MOVE.DEEPEN
      : CONVERSATION_MOVE.OFFER_ENTRY;
    if (questionMove === CONVERSATION_MOVE.OFFER_ENTRY) {
      return this._plan(questionMove, RESPONSE_CUE.LOW_BURDEN, "companion", depth);
    }
    return this._plan(questionMove, RESPONSE_CUE.QUESTION, "companion", depth);
  }

  _plan(move, responseCue, stance, depth) {
    return { move, responseCue, stance, depth };
  }

  _recordPlan(plan) {
    this.lastMove = plan?.move || "none";
    this.lastResponseCue = plan?.responseCue || RESPONSE_CUE.NONE;
  }

  _afterPlayback(plan) {
    if (
      this.lifecycle !== "active" ||
      this.paused ||
      this.mode === "follow-user" ||
      this.proactiveTurns >= (this.mode === "ai-leads" ? 3 : 1)
    ) {
      return [];
    }
    const switchTopic =
      this.mode === "ai-leads" &&
      this.lowInterestTurns >= 2 &&
      this.sameTopicContinuations >= 1;
    return [{
      type: "schedule-proactive",
      kind: switchTopic ? "idle" : "followup",
      delayMs: switchTopic ? this.delays.topicSwitch : responseDelay(plan, this.delays),
    }];
  }

  _onSilenceDeadline(kind) {
    if (
      this.lifecycle !== "active" ||
      this.paused ||
      this.mode === "follow-user" ||
      this.proactiveTurns >= (this.mode === "ai-leads" ? 3 : 1)
    ) {
      return [];
    }
    const proactiveKind = kind === "idle" ? "idle" : "followup";
    const plan = this._nextPlan();
    this._recordPlan(plan);
    return [{ type: "request-reply", kind: proactiveKind, plan }];
  }

  _onHardControl(control) {
    if (control === "resume") {
      this.paused = false;
      return [{ type: "resume-leading" }];
    }
    if (control === "redirect") {
      this.lowInterestTurns = 0;
      this.sameTopicContinuations = 0;
      this.depth = 0;
      this.initiativeDebt = 0;
      this.topicTurns = 0;
      this.lateralRecoveryTurns = 0;
      this.lateralCooldownTurns = 0;
      return [{ type: "cancel-proactive" }, { type: "seal-topic" }];
    }
    this.paused = true;
    return [{ type: "cancel-proactive" }, { type: "pause-leading" }];
  }

  _stop() {
    this.lifecycle = "stopped";
    this.paused = true;
    this.proactiveTurns = 0;
    this.lowInterestTurns = 0;
    this.sameTopicContinuations = 0;
    this.lastMove = "none";
    this.lastResponseCue = RESPONSE_CUE.NONE;
    this.depth = 0;
    this.initiativeDebt = 0;
    this.topicTurns = 0;
    this.lateralMoves = 0;
    this.lateralRecoveryTurns = 0;
    this.lateralCooldownTurns = 0;
    this.topicActivity = { active: 0, neutral: 0, settling: 0, sensitive: 0 };
  }
}

export function createConversationDirector(options = {}) {
  return new ConversationDirector(options);
}
