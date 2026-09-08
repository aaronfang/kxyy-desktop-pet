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

export function sharedExperienceReplyMaxTokens(active, requested) {
  const normalized = Math.max(1, Math.floor(Number(requested) || 1));
  // Keep room for a natural companion reply while retaining a bounded TTS job.
  return active ? Math.min(320, normalized) : normalized;
}

export function sharedExperienceTtsLatencyMode(active) {
  return active ? "companion" : "default";
}

export function sharedExperienceCaptureDelay({ kind, failed = false } = {}) {
  return kind === "audio" && !failed ? 0 : 3000;
}
