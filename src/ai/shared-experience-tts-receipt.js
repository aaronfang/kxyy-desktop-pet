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
    streamUnderruns: 0,
    streamMaxGapMs: 0,
  };
  return {
    admit() { state.admittedParts += 1; },
    start() {
      state.startedParts += 1;
      if (state.firstAudioAtMs === null) state.firstAudioAtMs = Number(nowMs()) || startedAtMs;
    },
    complete() { state.completedParts += 1; },
    fail() { state.failedParts += 1; },
    observeStream(value = {}) {
      state.streamObserved = true;
      state.streamUnderruns += Math.min(10_000, Math.max(0, Math.floor(Number(value.underrunCount) || 0)));
      state.streamMaxGapMs = Math.max(
        state.streamMaxGapMs,
        Math.min(60_000, Math.max(0, Math.round(Number(value.maxGapMs) || 0))),
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
      if (state.streamObserved) {
        receipt.stream = {
          underrunCount: state.streamUnderruns,
          maxGapMs: state.streamMaxGapMs,
        };
      }
      return receipt;
    },
  };
}
