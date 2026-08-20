const DEFAULT_IDLE_DELAY_MS = 90_000;

export function createFreshIdleState({ nowMs = Date.now(), delayMs = DEFAULT_IDLE_DELAY_MS } = {}) {
  return {
    lastActivityAt: Number.isFinite(nowMs) ? nowMs : Date.now(),
    delayMs: Math.max(30_000, Number(delayMs) || DEFAULT_IDLE_DELAY_MS),
    triggered: false,
  };
}

export function recordFreshIdleActivity(state, nowMs = Date.now()) {
  if (!state) return;
  state.lastActivityAt = Number.isFinite(nowMs) ? nowMs : Date.now();
}

export function shouldTriggerFreshIdle(state, {
  nowMs = Date.now(),
  enabled = false,
  participation = "relevant",
  ambientUsed = false,
  busy = false,
  hasPendingMedia = false,
  callActive = false,
  inputFocused = false,
  seriousContext = false,
  hidden = false,
  hasConversation = true,
} = {}) {
  if (!state || state.triggered || !enabled || !["occasional", "active"].includes(participation)) return false;
  if (ambientUsed || busy || hasPendingMedia || callActive || inputFocused || seriousContext || hidden || !hasConversation) return false;
  return nowMs - state.lastActivityAt >= state.delayMs;
}

export function markFreshIdleTriggered(state) {
  if (!state || state.triggered) return false;
  state.triggered = true;
  return true;
}

export { DEFAULT_IDLE_DELAY_MS };
