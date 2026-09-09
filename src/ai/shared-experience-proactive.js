import { isQuestionEvidenceUsable, videoQuestionEvidence } from "./shared-experience-evidence-window.js";
import { findSharedExperienceAuditStyle } from "./shared-experience-dialogue-style.js";

const DEFAULT_FIRST_DELAY_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const MAX_CONSUMED_EVIDENCE = 128;
const FREQUENCY_SCHEDULES = Object.freeze({
  low: Object.freeze({ firstDelayMs: 60_000, minIntervalMs: 120_000 }),
  standard: Object.freeze({ firstDelayMs: DEFAULT_FIRST_DELAY_MS, minIntervalMs: DEFAULT_MIN_INTERVAL_MS }),
  frequent: Object.freeze({ firstDelayMs: 20_000, minIntervalMs: 30_000 }),
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
  return {
    enabled: typeof overrides.enabled === "boolean"
      ? overrides.enabled
      : settings?.sharedExperienceProactiveEnabled === true,
    frequency,
    firstDelayMs: boundedMs(overrides.firstDelayMs, schedule.firstDelayMs),
    minIntervalMs: boundedMs(overrides.minIntervalMs, schedule.minIntervalMs),
  };
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
  if (!text || text.length > 120 || /[?？]/u.test(text)) return false;
  if (/^(?:为什么|怎么|你觉得|要不要|是不是|会不会|难道)/u.test(text)) return false;
  if (/(?:没看明白|先不乱猜|不太清楚|证据|资料里|根据画面|根据声音)/u.test(text)) return false;
  if (/(?:声音|旁白|解说).{0,40}画面|画面.{0,40}(?:声音|旁白|解说)/u.test(text)) return false;
  if (/(?:回答你|你刚才问|这个问题|问题的答案|答案是)/u.test(text)) return false;
  if (findSharedExperienceAuditStyle(text).length) return false;
  const sentences = text.split(/(?<=[。！？.!?])/u).map((part) => part.trim()).filter(Boolean);
  return sentences.length <= 2;
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

export function createSharedExperienceProactiveDirector({
  startedAtMs = Date.now(),
  firstDelayMs = DEFAULT_FIRST_DELAY_MS,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
} = {}) {
  const state = {
    startedAtMs: boundedMs(startedAtMs, Date.now()),
    firstDelayMs: boundedMs(firstDelayMs, DEFAULT_FIRST_DELAY_MS),
    minIntervalMs: boundedMs(minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
    lastSpokenAtMs: null,
    lastAttemptAtMs: null,
    pending: null,
    consumed: [],
    consumedSet: new Set(),
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

  const consumePending = () => {
    for (const id of state.pending?.consumedIds || []) {
      if (state.consumedSet.has(id)) continue;
      state.consumed.push(id);
      state.consumedSet.add(id);
    }
    while (state.consumed.length > MAX_CONSUMED_EVIDENCE) {
      state.consumedSet.delete(state.consumed.shift());
    }
  };

  return {
    offer({ atMs = Date.now(), snapshot = {}, userActive = false, paused = false, hidden = false, busy = false, speaking = false } = {}) {
      if (state.pending) return suppress("pending");
      if (userActive) return suppress("user-active");
      if (paused) return suppress("paused");
      if (hidden) return suppress("hidden");
      if (busy) return suppress("busy");
      if (speaking) return suppress("speaking");
      const now = boundedMs(atMs, Date.now());
      const nextAtMs = state.lastAttemptAtMs === null
        ? state.startedAtMs + state.firstDelayMs
        : state.lastAttemptAtMs + state.minIntervalMs;
      if (now < nextAtMs) return suppress("cooldown");
      const events = (Array.isArray(snapshot?.evidenceJournal) ? snapshot.evidenceJournal : [])
        .map(cleanEvidence).filter(Boolean)
        .filter((event) => !state.consumedSet.has(event.id) && event.atMs <= now)
        .sort((a, b) => a.atMs - b.atMs);
      if (!events.length) return suppress("no-new-evidence");

      const mode = String(snapshot?.contentMode || "unknown");
      const audio = audioCandidate(events);
      const visual = visualCandidate(events);
      let selected = [];
      let reason = "";
      if (mode === "narrated" && audio.length) {
        selected = audio;
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
      if (!selected.length) return suppress(visual.repeated ? "repeated-evidence" : "not-meaningful");
      const selectedThroughMs = selected.at(-1)?.atMs ?? now;
      state.pending = {
        evidenceIds: selected.map((event) => event.id),
        consumedIds: events.filter((event) => event.atMs <= selectedThroughMs).map((event) => event.id),
        reason,
      };
      state.offered += 1;
      return { offered: true, reason, evidenceIds: [...state.pending.evidenceIds] };
    },

    complete({ spoken = false, atMs = Date.now() } = {}) {
      if (!state.pending) return false;
      const completedAtMs = boundedMs(atMs, Date.now());
      if (!spoken) {
        consumePending();
        state.lastAttemptAtMs = completedAtMs;
        state.pending = null;
        state.failed += 1;
        return false;
      }
      consumePending();
      state.lastSpokenAtMs = completedAtMs;
      state.lastAttemptAtMs = completedAtMs;
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
  return { status, totalMs };
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

  const record = (event) => {
    events.push(event);
    while (events.length > 32) events.shift();
  };

  return {
    async consider(snapshot) {
      if (active) return { started: false, reason: "pending" };
      const candidate = director.offer({
        atMs: nowMs(),
        snapshot,
        ...(currentState() || {}),
      });
      if (!candidate.offered) return { started: false, reason: candidate.reason };
      const controller = new AbortController();
      const operation = { controller, candidate, cancelReason: "" };
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
        const emitted = result?.emitted === true && String(result?.text || "").trim().length > 0;
        director.complete({ spoken: emitted, text: result?.text, atMs: nowMs() });
        record({
          atMs: nowMs(),
          reason: candidate.reason,
          evidenceIds: [...candidate.evidenceIds],
          status: emitted ? "completed" : "failed",
          textChars: emitted ? String(result.text).trim().length : 0,
          ...(boundedTtsReceipt(result?.ttsReceipt) ? { tts: boundedTtsReceipt(result.ttsReceipt) } : {}),
        });
        return { started: true, emitted, ...(result?.ttsReceipt ? { ttsReceipt: result.ttsReceipt } : {}) };
      } catch (error) {
        if (controller.signal.aborted || active !== operation) {
          record({ atMs: nowMs(), reason: candidate.reason, evidenceIds: [...candidate.evidenceIds], status: "cancelled" });
          return { started: true, cancelled: true };
        }
        director.complete({ spoken: false, atMs: nowMs() });
        record({ atMs: nowMs(), reason: candidate.reason, evidenceIds: [...candidate.evidenceIds], status: "failed" });
        return { started: true, emitted: false, error: String(error?.message || error).slice(0, 160) };
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

    snapshot() {
      return {
        active: Boolean(active),
        director: director.snapshot(),
        events: events.map((event) => ({ ...event, evidenceIds: [...event.evidenceIds], ...(event.tts ? { tts: { ...event.tts } } : {}) })),
      };
    },
  };
}

export const sharedExperienceProactiveDefaults = Object.freeze({
  firstDelayMs: DEFAULT_FIRST_DELAY_MS,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
});
