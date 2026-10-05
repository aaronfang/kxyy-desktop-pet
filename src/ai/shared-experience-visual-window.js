const STATES = new Set(["quiet", "normal", "intense"]);
const REASONS = new Set(["initial", "interval", "scene-cut"]);
const MAX_IMAGE_DATA_URL_LENGTH = 2 * 1024 * 1024;

function boundedInteger(value, max = 1_000_000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.floor(number))) : 0;
}

function normalizeDiagnostics(value = {}) {
  const state = STATES.has(value?.state) ? value.state : "normal";
  return {
    state,
    bufferedFrames: boundedInteger(value?.bufferedFrames, 24),
    sampledFrames: boundedInteger(value?.sampledFrames),
    emittedWindows: boundedInteger(value?.emittedWindows),
    coalescedFrames: boundedInteger(value?.coalescedFrames),
    droppedFrames: boundedInteger(value?.droppedFrames),
    latestChangeScorePpm: boundedInteger(value?.latestChangeScorePpm),
    nextWindowInMs: boundedInteger(value?.nextWindowInMs, 60_000),
  };
}

export function normalizeSharedExperienceVisualCapture(value = {}) {
  const diagnostics = normalizeDiagnostics(value?.diagnostics);
  if (value?.status === "pending") return { pending: true, window: null, diagnostics };
  if (value?.status !== "ok" || !value.window || typeof value.window !== "object") return null;
  const frames = value.window.frames;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 4) return null;
  const normalizedFrames = [];
  for (const frame of frames) {
    const capturedAtMs = Number(frame?.capturedAtMs);
    const imageDataUrl = String(frame?.imageDataUrl || "");
    if (!Number.isFinite(capturedAtMs) || capturedAtMs < 0
      || !imageDataUrl.startsWith("data:image/jpeg;base64,")
      || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH
      || normalizedFrames.at(-1)?.capturedAtMs >= capturedAtMs) return null;
    normalizedFrames.push({ capturedAtMs, imageDataUrl });
  }
  const state = String(value.window.state || "");
  const reason = String(value.window.reason || "");
  if (!STATES.has(state) || !REASONS.has(reason)) return null;
  return {
    pending: false,
    window: {
      frames: normalizedFrames,
      capturedAtMs: normalizedFrames.at(-1).capturedAtMs,
      state,
      reason,
      sampledFrames: Math.max(normalizedFrames.length, boundedInteger(value.window.sampledFrames, 24)),
    },
    diagnostics,
  };
}
