import { isQuestionEvidenceUsable, videoQuestionEvidence } from "./shared-experience-evidence-window.js";
import { findSharedExperienceAuditStyle } from "./shared-experience-dialogue-style.js";

const DEFAULT_FIRST_DELAY_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const MAX_CONSUMED_EVIDENCE = 128;
const FREQUENCY_SCHEDULES = Object.freeze({
  low: Object.freeze({ firstDelayMs: 60_000, minIntervalMs: 120_000, jitterMs: 30_000 }),
  standard: Object.freeze({ firstDelayMs: DEFAULT_FIRST_DELAY_MS, minIntervalMs: DEFAULT_MIN_INTERVAL_MS }),
  // 高频把 20 秒作为主动发言之间的最短间隔。到点后仍须有新证据，
  // 由内容重要性决定是否开口，避免固定闹钟式复述。
  frequent: Object.freeze({ firstDelayMs: 20_000, minIntervalMs: 20_000, jitterMs: 8_000 }),
});
const ACTION = /(?:进入|离开|打开|关闭|拿到|发现|决定|计划|开始|停止|攻击|躲|跑|走|移动|转身|举枪|射击|战斗|击倒|追|逃|跳|爬|驾驶|撞|爆炸|出现|消失|切换|到达|返回|交换|使用)/u;

function boundedMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

export function resolveSharedExperienceProactiveConfig(settings = {}, overrides = {}) {
  const requestedFrequency = String(settings?.sharedExperienceProactiveFrequency || "").trim().toLowerCase();
  const frequency = Object.hasOwn(FREQUENCY_SCHEDULES, requestedFrequency) ? requestedFrequency : "standard";
  const schedule = FREQUENCY_SCHEDULES[frequency];
  const shortVideo = overrides.contentMode === "short-video";
  const firstDelayMs = shortVideo ? Math.max(8_000, Math.round(schedule.firstDelayMs / 2)) : schedule.firstDelayMs;
  const minIntervalMs = shortVideo ? Math.max(12_000, Math.round(schedule.minIntervalMs / 2)) : schedule.minIntervalMs;
  return {
    enabled: typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : settings?.sharedExperienceProactiveEnabled === true,
    frequency,
    firstDelayMs: boundedMs(overrides.firstDelayMs, firstDelayMs),
    minIntervalMs: boundedMs(overrides.minIntervalMs, minIntervalMs),
    jitterMs: boundedMs(overrides.jitterMs, schedule.jitterMs || 0),
  };
}

export function sharedExperienceProactiveDiagnostics(snapshot = {}, nowMs = Date.now()) {
  const director = snapshot?.director && typeof snapshot.director === "object" ? snapshot.director : {};
  const totals = snapshot?.totals && typeof snapshot.totals === "object" ? snapshot.totals : {};
  const nextEligibleAtMs = boundedMs(director.nextEligibleAtMs, 0);
  const timing = snapshot?.timing && typeof snapshot.timing === "object" ? snapshot.timing : {};
  const lastSpokenAtMs = boundedMs(timing.lastSpokenAtMs ?? director.lastSpokenAtMs, 0);
  return {
    frequency: Object.hasOwn(FREQUENCY_SCHEDULES, director.frequency) ? director.frequency : "standard",
    completed: Math.max(0, Math.floor(Number(totals.completed) || 0)),
    failed: Math.max(0, Math.floor(Number(totals.failed) || 0)),
    cancelled: Math.max(0, Math.floor(Number(totals.cancelled) || 0)),
    pending: snapshot?.active === true || director.pending === true,
    nextEligibleAtMs,
    nextEligibleInMs: Math.max(0, nextEligibleAtMs - boundedMs(nowMs, Date.now())),
    lastSpokenAtMs,
    lastSpokenAgoMs: lastSpokenAtMs > 0 ? Math.max(0, boundedMs(nowMs, Date.now()) - lastSpokenAtMs) : null,
    lastCompletedIntervalMs: timing.lastCompletedIntervalMs ?? null,
    maxCompletedIntervalMs: timing.maxCompletedIntervalMs ?? null,
    lastTurnDurationMs: timing.lastTurnDurationMs ?? null,
    maxTurnDurationMs: timing.maxTurnDurationMs ?? null,
    currentSuppressionReason: typeof timing.currentSuppressionReason === "string" ? timing.currentSuppressionReason : "",
    currentSuppressionForMs: timing.currentSuppressionSinceMs === null || !Number.isFinite(timing.currentSuppressionSinceMs)
      ? 0
      : Math.max(0, boundedMs(nowMs, Date.now()) - timing.currentSuppressionSinceMs),
    suppressions: director.suppressions && typeof director.suppressions === "object"
      ? { ...director.suppressions }
      : {},
  };
}

/**
 * Keep the per-request instruction aligned with the shared-experience persona
 * rules. The model should add an interpretation, not narrate the evidence
 * journal back to the viewer.
 */
export function sharedExperienceProactiveGroundingPrompt(reason = "", contentMode = "unknown") {
  if (contentMode === "short-video") return "这是连续短视频：只对最近这一条有证据的内容给一两句轻松短评，反应可以快但不要追着每个镜头报幕；不同视频可能完全无关，不把前一条人物和事件套进这一条。证据不够时宁可不猜，不要编造切换或结局。";
  if (reason === "initial-orientation") return "这是重新开始陪看后的第一次主动回应。先用一两句概括本次陪看开头已经确认的证据，再自然连接当前焦点并给出一个有依据的判断；不要只解说当前一帧，也不要编造缺失的前情、人物身份或因果。开头证据不足时保留不确定性，整段仍要像朋友陪看一样自然简短。";
  if (contentMode === "livestream") return "这是直播陪看：跟着直播当下的动作、聊天和氛围自然接话，必要时回扣刚才的变化；安静或停顿时不硬凑剧情或结局，保持像朋友偶尔插话的语气。";
  if (contentMode === "game-narrated") return "这是游戏解说：结合讲解中的目标、策略和结果与已看到的操作变化，说一个具体判断或感受；不要把游戏进展当电影剧情，也不要逐句复述主播。";
  if (reason === "follow-on-analysis") {
    return "请根据近期共同观看证据换一个角度分析：先给出你自己的判断，分析占主体（分析和感受至少一半），每次至少给出一个解释、评价或有依据的推断，优先谈人物选择、处境或局势后果；只用极少事实作铺垫，不要把画面或解说逐句复述，也不要机械播报。重要节点可以自然多说一两句，普通节点简短一点；如果有一个具体的人物身份、动机或因果关系值得和用户确认，可以在分析末尾顺带问一个小问题，但问题必须依附在前面的分析后面，不要把问题单独当成发言。不要重复上一条评论，不要编造新进展，不要把不确定的人名、动机说死，也不要用‘声音说了/画面显示’或证据审计式说法。";
  }
  return "请根据本轮焦点证据主动分享你的分析：先说你的判断，分析占主体（分析和感受至少一半），至少给出一个解释、评价或有依据的推断，优先谈人物选择、处境、动机或局势变化会带来什么后果；解说内容可以作为剧情主线，画面只用来补充场景、动作和情绪，不要求二者逐句对应，也不要反复解释它们是否对得上。不要先复述，事实只用来铺垫判断，不要只报幕或复述画面、解说，不要机械复述。重要节点可以自然多说一两句，普通节点简短一点；信息足够且确实有悬念时，可以在自己的分析后偶尔问一个具体的小问题，例如刚才那个人是谁、他为什么会这样做，但问题不能单独成为整条发言。至少把一个事实和你的判断之间的因果或影响说清楚。不要把未知片名、人名、动机说成事实，不要用‘声音说了/画面显示’或证据审计式说法。";
}

function cleanEvidence(event) {
  if (!event || !["audio", "visual"].includes(event.kind) || typeof event.id !== "string") return null;
  const normalized = videoQuestionEvidence(event);
  const text = String(normalized?.text || "").replace(/\s+/gu, " ").trim().slice(0, 360);
  if (!text || !Number.isFinite(Number(event.atMs))) return null;
  return { id: event.id.slice(0, 80), kind: event.kind, atMs: Number(event.atMs), text };
}

function signature(text) {
  return String(text || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 160);
}

export function isSharedExperienceProactiveReply(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text || text.length > 240) return false;
  const questions = (text.match(/[?？]/gu) || []).length;
  if (questions > 1) return false;
  // An occasional question should follow a companion-like observation; a
  // bare question is only a prompt for the viewer, not proactive analysis.
  if (questions === 1 && text.split(/(?<=[。！？.!?])/u).filter((part) => part.trim()).length === 1) return false;
  if (/^(?:你觉得|要不要|是不是|会不会|难道)\s*[^。！？.!?]*[?？]$/u.test(text)) return false;
  if (/(?:没看明白|先不乱猜|不太清楚|证据|资料里|根据画面|根据声音)/u.test(text)) return false;
  if (/(?:声音|旁白|解说).{0,40}画面|画面.{0,40}(?:声音|旁白|解说)/u.test(text)) return false;
  if (/(?:回答你|你刚才问|这个问题|问题的答案|答案是)/u.test(text)) return false;
  if (findSharedExperienceAuditStyle(text).length) return false;
  const sentences = text.split(/(?<=[。！？.!?])/u).map((part) => part.trim()).filter(Boolean);
  return sentences.length <= 4;
}

export function cancelSharedExperienceProactiveWork({
  runner,
  reason = "cancelled",
  stopOutput,
  stopOutputWhenIdle = false,
} = {}) {
  const cancelled = runner?.cancel(reason) === true;
  if (typeof stopOutput === "function" && (cancelled || stopOutputWhenIdle)) stopOutput();
  return cancelled;
}

function audioCandidate(events) {
  return events.filter((event) => event.kind === "audio" && isQuestionEvidenceUsable(event)
    && ((event.text.match(/\p{Script=Han}/gu) || []).length >= 8 || ACTION.test(event.text))).slice(-2);
}

function visualCandidate(events) {
  const visual = events.filter((event) => event.kind === "visual").slice(-3);
  if (visual.length < 2) return { events: [], repeated: false };
  const unique = [...new Set(visual.map((event) => signature(event.text)).filter(Boolean))];
  if (unique.length < 2) return { events: [], repeated: true };
  if (!visual.some((event) => ACTION.test(event.text))) return { events: [], repeated: false };
  return { events: visual, repeated: false };
}

function narratedCandidate(events, audio) {
  if (!audio.length) return [];
  const lastAudioAtMs = audio.at(-1)?.atMs ?? -Infinity;
  const nearbyVisual = events
    .filter((event) => event.kind === "visual" && event.atMs <= lastAudioAtMs
      && event.atMs >= lastAudioAtMs - 20_000 && ACTION.test(event.text))
    .slice(-2);
  // Keep ASR first so the model treats narration as the plot spine. Visual
  // events are supporting context only and are never required to line up with
  // every spoken sentence.
  return [...audio, ...nearbyVisual.filter((event) => !audio.some((item) => item.id === event.id))];
}

export function createSharedExperienceProactiveDirector({
  startedAtMs = Date.now(),
  firstDelayMs = DEFAULT_FIRST_DELAY_MS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  frequency = "standard",
  earlyIntervalMs = null,
  followOnWindowMs = 0,
  jitterMs = 0,
  warmupMinEvents = 0,
  initialOrientation = false,
} = {}) {
  const state = {
    startedAtMs: boundedMs(startedAtMs, Date.now()),
    firstDelayMs: boundedMs(firstDelayMs, DEFAULT_FIRST_DELAY_MS),
    minIntervalMs: boundedMs(minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
    frequency: Object.hasOwn(FREQUENCY_SCHEDULES, frequency) ? frequency : "standard",
    earlyIntervalMs: earlyIntervalMs === null ? null : boundedMs(earlyIntervalMs, 0),
    followOnWindowMs: boundedMs(followOnWindowMs, 0),
    jitterMs: boundedMs(jitterMs, 0),
    warmupMinEvents: Math.max(0, Math.min(16, Math.floor(Number(warmupMinEvents) || 0))),
    initialOrientation: initialOrientation === true,
    lastSpokenAtMs: null,
    lastAttemptAtMs: null,
    nextEligibleAtMs: boundedMs(startedAtMs, Date.now()) + boundedMs(firstDelayMs, DEFAULT_FIRST_DELAY_MS),
    pending: null,
    consumed: [],
    consumedSet: new Set(),
    consumedThroughMs: -Infinity,
    followOnConsumed: new Set(),
    offered: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    suppressions: {
      "user-active": 0,
      paused: 0,
      hidden: 0,
      busy: 0,
      speaking: 0,
      cooldown: 0,
      "no-new-evidence": 0,
      "repeated-evidence": 0,
      "not-meaningful": 0,
      pending: 0,
    },
  };

  const suppress = (reason) => {
    if (Object.hasOwn(state.suppressions, reason)) state.suppressions[reason] += 1;
    return { offered: false, reason };
  };

  // The configured interval is a hard lower bound between speech starts.
  // Evidence arrival and the one-second ticker provide natural variation;
  // temporal jitter must never make a frequent session speak early.
  const nextDelay = () => state.minIntervalMs;
  const reconfigure = ({ frequency = state.frequency, firstDelayMs = state.firstDelayMs, minIntervalMs = state.minIntervalMs, jitterMs = state.jitterMs, atMs = Date.now() } = {}) => {
    const now = boundedMs(atMs, Date.now());
    state.frequency = Object.hasOwn(FREQUENCY_SCHEDULES, frequency) ? frequency : state.frequency;
    state.firstDelayMs = boundedMs(firstDelayMs, state.firstDelayMs);
    state.minIntervalMs = boundedMs(minIntervalMs, state.minIntervalMs);
    state.jitterMs = boundedMs(jitterMs, state.jitterMs);
    state.nextEligibleAtMs = state.lastAttemptAtMs === null
      ? Math.max(state.nextEligibleAtMs, now + state.firstDelayMs)
      : state.lastAttemptAtMs + state.minIntervalMs;
    return state.nextEligibleAtMs;
  };

  const consumePending = () => {
    // Old journal entries must stay consumed even after their IDs leave the
    // bounded ledger. Late evidence before this boundary remains available to
    // questions/summaries, but must not trigger a stale proactive comment.
    state.consumedThroughMs = Math.max(state.consumedThroughMs, state.pending?.selectedThroughMs ?? -Infinity);
    for (const id of state.pending?.consumedIds || []) {
      if (state.consumedSet.has(id)) continue;
      state.consumed.push(id);
      state.consumedSet.add(id);
    }
    while (state.consumed.length > MAX_CONSUMED_EVIDENCE) {
      state.consumedSet.delete(state.consumed.shift());
    }
    if (state.pending?.reason === "follow-on-analysis") {
      for (const id of state.pending.evidenceIds || []) state.followOnConsumed.add(id);
      while (state.followOnConsumed.size > MAX_CONSUMED_EVIDENCE) {
        state.followOnConsumed.delete(state.followOnConsumed.values().next().value);
      }
    }
  };

  return {
    reconfigure,
    offer({ atMs = Date.now(), snapshot = {}, userActive = false, paused = false, busy = false, speaking = false } = {}) {
      if (state.pending) return suppress("pending");
      if (userActive) return suppress("user-active");
      if (paused) return suppress("paused");
      if (busy) return suppress("busy");
      if (speaking) return suppress("speaking");
      const now = boundedMs(atMs, Date.now());
      const elapsedMs = state.lastAttemptAtMs === null
        ? now - state.startedAtMs
        : now - state.lastAttemptAtMs;
      if (now < state.nextEligibleAtMs) return suppress("cooldown");
      const mode = String(snapshot?.contentMode || "unknown");
      const events = (Array.isArray(snapshot?.evidenceJournal) ? snapshot.evidenceJournal : [])
        .map(cleanEvidence).filter(Boolean)
        .filter((event) => event.atMs > state.consumedThroughMs && !state.consumedSet.has(event.id) && event.atMs <= now)
        .filter((event) => mode !== "short-video" || event.atMs >= now - 24_000)
        .sort((a, b) => a.atMs - b.atMs);
      if (state.initialOrientation && state.completed === 0 && state.failed === 0
        && events.length < state.warmupMinEvents) return suppress("warmup");
      if (!events.length && (state.followOnWindowMs === 0 || now < state.nextEligibleAtMs)) {
        return suppress("no-new-evidence");
      }

      const audio = audioCandidate(events);
      const visual = visualCandidate(events);
      let selected = [];
      let reason = "";
      if (mode === "short-video" && events.length) {
        selected = events.slice(-1);
        reason = "short-video-update";
      } else if (["narrated", "game-narrated"].includes(mode) && audio.length) {
        selected = narratedCandidate(events, audio);
        reason = "narration-event";
      } else if (["low-speech-game", "livestream"].includes(mode) && visual.events.length) {
        selected = visual.events;
        reason = "visual-change";
      } else if (audio.length) {
        selected = audio;
        reason = "speech-event";
      } else if (visual.events.length) {
        selected = visual.events;
        reason = "visual-change";
      }
      if (!selected.length && mode !== "short-video" && state.followOnWindowMs > 0 && elapsedMs >= state.minIntervalMs) {
        const recent = (Array.isArray(snapshot?.evidenceJournal) ? snapshot.evidenceJournal : [])
          .map(cleanEvidence).filter(Boolean)
          .filter((event) => event.atMs <= now && event.atMs >= now - state.followOnWindowMs)
          .sort((a, b) => a.atMs - b.atMs);
        const recentAudio = audioCandidate(recent);
        const recentVisual = visualCandidate(recent);
        selected = recentAudio.length ? recentAudio : recentVisual.events;
        if (selected.length && selected.every((event) => state.followOnConsumed.has(event.id))) selected = [];
        if (selected.length) reason = "follow-on-analysis";
      }
      // A frequency setting is also a service-level deadline: once the
      // configured interval has elapsed, fresh evidence should still produce
      // a companion comment even when it lacks an action keyword. The prompt
      // asks the model to add an interpretation, so this fallback does not
      // turn the feature into a frame-by-frame narration loop.
      if (!selected.length && events.length && elapsedMs >= state.minIntervalMs) {
        selected = events.slice(-2);
        reason = "cadence-analysis";
      }
      if (!selected.length) return suppress(!events.length ? "no-new-evidence" : visual.repeated ? "repeated-evidence" : "not-meaningful");
      // Frequency is a hard lower bound. An old caller may still pass an
      // `earlyIntervalMs` hint, but important evidence must wait for the same
      // configured minimum instead of creating a burst of speech.
      if (state.lastAttemptAtMs !== null && elapsedMs < state.minIntervalMs) return suppress("cooldown");
      const selectedThroughMs = selected.reduce((latest, event) => Math.max(latest, event.atMs), -Infinity);
      state.pending = {
        offeredAtMs: now,
        selectedThroughMs,
        evidenceIds: selected.map((event) => event.id),
        consumedIds: events.filter((event) => event.atMs <= selectedThroughMs).map((event) => event.id),
        reason: state.initialOrientation && state.completed === 0 ? "initial-orientation" : reason,
      };
      state.offered += 1;
      return { offered: true, reason: state.pending.reason, evidenceIds: [...state.pending.evidenceIds] };
    },

    complete({ spoken = false, atMs = Date.now() } = {}) {
      if (!state.pending) return false;
      const completedAtMs = boundedMs(atMs, Date.now());
      if (!spoken) {
        consumePending();
        state.lastAttemptAtMs = state.pending?.offeredAtMs ?? completedAtMs;
        state.nextEligibleAtMs = (state.pending?.offeredAtMs ?? completedAtMs) + nextDelay();
        state.pending = null;
        state.failed += 1;
        return false;
      }
      consumePending();
      state.lastSpokenAtMs = completedAtMs;
      state.lastAttemptAtMs = state.pending.offeredAtMs;
      state.nextEligibleAtMs = state.pending.offeredAtMs + nextDelay();
      state.pending = null;
      state.completed += 1;
      return true;
    },

    cancel(reason = "") {
      if (!state.pending) return false;
      state.pending = null;
      state.cancelled += 1;
      if (Object.hasOwn(state.suppressions, reason)) state.suppressions[reason] += 1;
      return true;
    },

    snapshot() {
      return {
        frequency: state.frequency,
        firstDelayMs: state.firstDelayMs,
        minIntervalMs: state.minIntervalMs,
        nextEligibleAtMs: state.nextEligibleAtMs,
        offered: state.offered,
        completed: state.completed,
        failed: state.failed,
        cancelled: state.cancelled,
        lastSpokenAtMs: state.lastSpokenAtMs,
        pending: Boolean(state.pending),
        consumedEvidence: state.consumed.length,
        suppressions: { ...state.suppressions },
      };
    },
  };
}

function boundedTtsReceipt(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["completed", "partial", "failed"].includes(value.status) ? value.status : "failed";
  const totalMs = Math.min(120_000, Math.max(0, Math.round(Number(value.totalMs) || 0)));
  const count = (key) => Math.min(64, Math.max(0, Math.floor(Number(value[key]) || 0)));
  const stream = value.stream && typeof value.stream === "object"
    && Number.isSafeInteger(value.stream.underrunCount) && value.stream.underrunCount >= 0
    && typeof value.stream.maxGapMs === "number" && Number.isFinite(value.stream.maxGapMs) && value.stream.maxGapMs >= 0
    ? {
      underrunCount: Math.min(10_000, value.stream.underrunCount),
      maxGapMs: Math.min(60_000, value.stream.maxGapMs),
    } : null;
  return {
    status, totalMs,
    backend: value.backend === "voxcpm" ? "voxcpm" : "mixed-or-unknown",
    requestedParts: count("requestedParts"),
    admittedParts: count("admittedParts"),
    startedParts: count("startedParts"),
    completedParts: count("completedParts"),
    failedParts: count("failedParts"),
    ...(stream ? { stream } : {}),
  };
}

function validProactivePlayback(receipt) {
  return receipt?.status === "completed" && receipt.backend === "voxcpm"
    && receipt.requestedParts > 0 && receipt.failedParts === 0
    && receipt.requestedParts === receipt.admittedParts
    && receipt.admittedParts === receipt.startedParts
    && receipt.startedParts === receipt.completedParts
    && receipt.stream?.underrunCount === 0 && receipt.stream?.maxGapMs === 0;
}

export function createSharedExperienceProactiveRunner({
  director,
  generate,
  currentState = () => ({}),
  nowMs = () => Date.now(),
} = {}) {
  if (!director || typeof director.offer !== "function" || typeof director.complete !== "function") {
    throw new TypeError("director is required");
  }
  if (typeof generate !== "function") throw new TypeError("generate is required");
  if (typeof currentState !== "function") throw new TypeError("currentState must be a function");
  let active = null;
  const events = [];
  const totals = { completed: 0, failed: 0, cancelled: 0, ttsFailed: 0, ttsPartial: 0, ttsIncomplete: 0 };
  const timing = {
    lastSpokenAtMs: null,
    lastCompletedIntervalMs: null,
    maxCompletedIntervalMs: null,
    lastTurnDurationMs: null,
    maxTurnDurationMs: null,
    currentSuppressionReason: "",
    currentSuppressionSinceMs: null,
  };

  const record = (event) => {
    if (event.status === "completed") totals.completed += 1;
    else if (event.status === "cancelled") totals.cancelled += 1;
    else if (event.status === "failed") totals.failed += 1;
    if (event.failureReason === "tts-failed") totals.ttsFailed += 1;
    if (event.failureReason === "tts-partial") totals.ttsPartial += 1;
    if (event.failureReason === "tts-incomplete") totals.ttsIncomplete += 1;
    events.push(event);
    while (events.length > 32) events.shift();
  };

  return {
    async consider(snapshot) {
      if (active) return { started: false, reason: "pending" };
      const offeredAtMs = nowMs();
      const candidate = director.offer({
        atMs: offeredAtMs,
        snapshot,
        ...(currentState() || {}),
      });
      if (!candidate.offered) {
        if (timing.currentSuppressionReason !== candidate.reason) {
          timing.currentSuppressionReason = candidate.reason;
          timing.currentSuppressionSinceMs = offeredAtMs;
        }
        return { started: false, reason: candidate.reason };
      }
      timing.currentSuppressionReason = "";
      timing.currentSuppressionSinceMs = null;
      const controller = new AbortController();
      const operation = { controller, candidate, cancelReason: "", offeredAtMs };
      active = operation;
      try {
        const result = await generate({
          reason: candidate.reason,
          evidenceIds: [...candidate.evidenceIds],
          signal: controller.signal,
        });
        if (controller.signal.aborted || active !== operation) {
          record({ atMs: nowMs(), reason: candidate.reason, evidenceIds: [...candidate.evidenceIds], status: "cancelled" });
          return { started: true, cancelled: true };
        }
        const ttsReceipt = boundedTtsReceipt(result?.ttsReceipt);
        const ttsStatus = ttsReceipt?.status;
        const emitted = result?.emitted === true && String(result?.text || "").trim().length > 0
          && validProactivePlayback(ttsReceipt);
        const failureReason = emitted ? "" : (ttsStatus === "failed" ? "tts-failed"
          : ttsStatus === "partial" ? "tts-partial"
            : result?.emitted === true && !validProactivePlayback(ttsReceipt) ? "tts-incomplete"
            : ["grounding-rejected", "style-rejected", "stale-session"].includes(result?.failureReason)
              ? result.failureReason : "no-output");
        const completedAtMs = nowMs();
        director.complete({ spoken: emitted, atMs: completedAtMs });
        if (emitted) {
          const previousSpokenAtMs = timing.lastSpokenAtMs;
          timing.lastTurnDurationMs = Math.max(0, completedAtMs - operation.offeredAtMs);
          timing.maxTurnDurationMs = Math.max(timing.maxTurnDurationMs || 0, timing.lastTurnDurationMs);
          timing.lastSpokenAtMs = completedAtMs;
          if (previousSpokenAtMs !== null) {
            timing.lastCompletedIntervalMs = Math.max(0, completedAtMs - previousSpokenAtMs);
            timing.maxCompletedIntervalMs = Math.max(timing.maxCompletedIntervalMs || 0, timing.lastCompletedIntervalMs);
          }
        }
        record({
          atMs: completedAtMs,
          offeredAtMs: operation.offeredAtMs,
          turnDurationMs: Math.max(0, completedAtMs - operation.offeredAtMs),
          reason: candidate.reason,
          evidenceIds: [...candidate.evidenceIds],
          status: emitted ? "completed" : "failed",
          ...(failureReason ? { failureReason } : {}),
          textChars: emitted ? String(result.text).trim().length : 0,
          ...(ttsReceipt ? { tts: ttsReceipt } : {}),
        });
        return { started: true, emitted, ...(result?.ttsReceipt ? { ttsReceipt: result.ttsReceipt } : {}) };
      } catch (error) {
        if (controller.signal.aborted || active !== operation) {
          record({ atMs: nowMs(), reason: candidate.reason, evidenceIds: [...candidate.evidenceIds], status: "cancelled" });
          return { started: true, cancelled: true };
        }
        director.complete({ spoken: false, atMs: nowMs() });
        record({ atMs: nowMs(), reason: candidate.reason, evidenceIds: [...candidate.evidenceIds], status: "failed", failureReason: "generation-failed" });
        return { started: true, emitted: false, failureReason: "generation-failed" };
      } finally {
        if (active === operation) active = null;
      }
    },

    cancel(reason = "cancelled") {
      if (!active) return false;
      const operation = active;
      active = null;
      operation.cancelReason = String(reason || "cancelled").slice(0, 40);
      director.cancel(operation.cancelReason);
      operation.controller.abort();
      return true;
    },

    reconfigure(config = {}) {
      return typeof director.reconfigure === "function" ? director.reconfigure(config) : false;
    },

    snapshot() {
      return {
        active: Boolean(active),
        director: director.snapshot(),
        totals: { ...totals },
        timing: { ...timing },
        events: events.map((event) => ({ ...event, evidenceIds: [...event.evidenceIds], ...(event.tts ? { tts: { ...event.tts } } : {}) })),
      };
    },
  };
}

export const sharedExperienceProactiveDefaults = Object.freeze({
  firstDelayMs: DEFAULT_FIRST_DELAY_MS,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
});
