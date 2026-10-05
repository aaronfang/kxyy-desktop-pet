export function createTtsReceipt({ requestedParts = 0, nowMs = () => performance.now() } = {}) {
  const startedAtMs = Number(nowMs()) || 0;
  const state = {
    requestedParts: Math.max(0, Math.floor(Number(requestedParts) || 0)),
    admittedParts: 0,
    startedParts: 0,
    completedParts: 0,
    failedParts: 0,
    firstAudioAtMs: null,
    streamObserved: false,
    streamInvalid: false,
    streamUnderruns: 0,
    streamMaxGapMs: 0,
    failureReasons: {},
  };
  return {
    admit() { state.admittedParts += 1; },
    start() {
      state.startedParts += 1;
      if (state.firstAudioAtMs === null) state.firstAudioAtMs = Number(nowMs()) || startedAtMs;
    },
    complete() { state.completedParts += 1; },
    fail(reason) {
      state.failedParts += 1;
      const fixed = ["audio-context-suspended", "audio-context-unavailable", "queue-reset", "stream-error"].includes(reason)
        ? reason : "unknown";
      state.failureReasons[fixed] = (state.failureReasons[fixed] || 0) + 1;
    },
    observeBackend(value) {
      const backend = ["voxcpm", "local", "cosyvoice"].includes(value) ? value : "mixed-or-unknown";
      state.backend = state.backend === undefined || state.backend === backend ? backend : "mixed-or-unknown";
    },
    observeStream(value = {}) {
      if (!Number.isSafeInteger(value?.underrunCount) || value.underrunCount < 0
        || typeof value?.maxGapMs !== "number" || !Number.isFinite(value.maxGapMs) || value.maxGapMs < 0) {
        state.streamInvalid = true;
        return;
      }
      state.streamObserved = true;
      state.streamUnderruns += Math.min(10_000, value.underrunCount);
      state.streamMaxGapMs = Math.max(
        state.streamMaxGapMs,
        Math.min(60_000, Math.round(value.maxGapMs)),
      );
    },
    finish() {
      const totalMs = Math.max(0, (Number(nowMs()) || startedAtMs) - startedAtMs);
      const status = state.completedParts === state.requestedParts && state.failedParts === 0
        ? "completed"
        : state.completedParts > 0
          ? "partial"
          : "failed";
      const receipt = {
        status,
        requestedParts: state.requestedParts,
        admittedParts: state.admittedParts,
        startedParts: state.startedParts,
        completedParts: state.completedParts,
        failedParts: state.failedParts,
        firstAudioMs: state.firstAudioAtMs === null ? null : Math.max(0, state.firstAudioAtMs - startedAtMs),
        totalMs,
      };
      if (state.streamObserved && !state.streamInvalid) {
        receipt.stream = {
          underrunCount: state.streamUnderruns,
          maxGapMs: state.streamMaxGapMs,
        };
      }
      if (state.failedParts) receipt.failureReasons = { ...state.failureReasons };
      if (state.backend !== undefined) receipt.backend = state.backend;
      return receipt;
    },
  };
}
