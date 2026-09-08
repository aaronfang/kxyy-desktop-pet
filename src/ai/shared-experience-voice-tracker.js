const STATES = new Set(["starting", "running", "stopped", "failed", "skipped"]);

export function createSharedExperienceVoiceTracker({ backend = "", nowMs = () => Date.now() } = {}) {
  const expectedBackend = String(backend || "").trim().toLowerCase();
  const startedAtMs = Number(nowMs()) || 0;
  const state = {
    runningSeen: false,
    disruptedAfterRunning: false,
    failures: 0,
    unexpectedRestarts: 0,
    events: [],
  };
  return {
    record(status = {}) {
      const statusBackend = String(status.backend || "").trim().toLowerCase();
      const next = String(status.state || "").trim().toLowerCase();
      if (statusBackend !== expectedBackend || !STATES.has(next)) return false;
      if (next === "failed") state.failures += 1;
      if (state.runningSeen && (next === "failed" || next === "stopped")) state.disruptedAfterRunning = true;
      if (next === "running") {
        if (state.disruptedAfterRunning) state.unexpectedRestarts += 1;
        state.runningSeen = true;
        state.disruptedAfterRunning = false;
      }
      state.events.push({ atMs: Math.max(0, (Number(nowMs()) || startedAtMs) - startedAtMs), state: next });
      while (state.events.length > 32) state.events.shift();
      return true;
    },
    snapshot() {
      return {
        backend: expectedBackend,
        runningSeen: state.runningSeen,
        failures: state.failures,
        unexpectedRestarts: state.unexpectedRestarts,
        events: state.events.map((event) => ({ ...event })),
      };
    },
  };
}
