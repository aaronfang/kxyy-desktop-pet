const ENABLED_POLICY = Object.freeze({
  memoryRecall: false,
  freshTopics: false,
  webObservations: false,
  fewShot: false,
  sessionRecap: false,
  automaticFollowup: false,
  idleProactive: false,
});

const DEFAULT_POLICY = Object.freeze({
  memoryRecall: true,
  freshTopics: true,
  webObservations: true,
  fewShot: true,
  sessionRecap: true,
  automaticFollowup: true,
  idleProactive: true,
});

export function sharedExperienceRequestPolicy(active) {
  return active ? { ...ENABLED_POLICY } : { ...DEFAULT_POLICY };
}

export function sharedExperienceReplyMaxTokens(active, requested, { deliberate = false, proactiveKind = null } = {}) {
  const normalized = Math.max(1, Math.floor(Number(requested) || 1));
  // DeepSeek reasoning shares max_tokens with the visible answer. The Rust proxy
  // multiplies this request budget by six when thinking is enabled, so reserve
  // enough room for reasoning without making ordinary companion replies longer.
  if (active && deliberate) return Math.max(1400, normalized);
  // Keep room for a natural companion reply while retaining a bounded TTS job.
  return active ? Math.min(proactiveKind === "shared-experience" ? 480 : 320, normalized) : normalized;
}

export function sharedExperienceTtsLatencyMode(active) {
  return active ? "companion" : "default";
}

export function sharedExperienceCaptureDelay({ kind, failed = false } = {}) {
  if (kind === "audio" && !failed) return 0;
  if (kind === "visual") return failed ? 1500 : 500;
  return 3000;
}
