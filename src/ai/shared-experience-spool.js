const CAPTURE_KINDS = new Set(["visual", "audio"]);
const DEFAULT_MAX_ITEMS = 48;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function estimateBytes(value) {
  if (value == null) return 0;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function normalizePauseReason(value) {
  const reason = String(value || "").trim();
  return reason || "default";
}

/**
 * In-memory bridge between capture and model workers.
 * Raw frames/audio may live here only temporarily; callers must clear it after processing.
 */
export function createSharedExperienceSpool({
  maxItems = DEFAULT_MAX_ITEMS,
  maxBytes = DEFAULT_MAX_BYTES,
  nowMs = () => Date.now(),
} = {}) {
  const state = {
    maxItems: Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS),
    maxBytes: Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES),
    pending: [],
    bytes: 0,
    dropped: 0,
    droppedByKind: { visual: 0, audio: 0, unknown: 0 },
    peakPending: 0,
    peakBytes: 0,
    pauseReasons: new Set(),
    sequence: 0,
  };

  const evictOldest = () => {
    const removed = state.pending.shift();
    if (!removed) return;
    state.bytes = Math.max(0, state.bytes - removed.bytes);
    state.dropped += 1;
    state.droppedByKind[removed.kind] = (state.droppedByKind[removed.kind] || 0) + 1;
  };

  return {
    push(capture = {}) {
      if (!CAPTURE_KINDS.has(capture.kind)) return null;
      const bytes = estimateBytes(capture.payload);
      if (!bytes || bytes > state.maxBytes) {
        state.dropped += 1;
        state.droppedByKind[capture.kind] = (state.droppedByKind[capture.kind] || 0) + 1;
        return null;
      }
      while (state.pending.length >= state.maxItems || state.bytes + bytes > state.maxBytes) evictOldest();
      const item = {
        sequence: ++state.sequence,
        kind: capture.kind,
        capturedAtMs: normalizeTimestamp(capture.capturedAtMs, nowMs()),
        payload: capture.payload,
        bytes,
      };
      state.pending.push(item);
      state.pending.sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.sequence - b.sequence);
      state.bytes += bytes;
      state.peakPending = Math.max(state.peakPending, state.pending.length);
      state.peakBytes = Math.max(state.peakBytes, state.bytes);
      return { ...item };
    },

    pauseInference(reason = "default") {
      state.pauseReasons.add(normalizePauseReason(reason));
    },

    resumeInference(reason = "default") {
      state.pauseReasons.delete(normalizePauseReason(reason));
    },

    drain(limit = Infinity) {
      if (state.pauseReasons.size) return [];
      const count = Math.max(0, Math.floor(Number(limit)) || 0) || state.pending.length;
      const drained = state.pending.splice(0, count);
      for (const item of drained) state.bytes = Math.max(0, state.bytes - item.bytes);
      return drained.map(({ bytes: _bytes, ...item }) => item);
    },

    drainKind(kind) {
      if (state.pauseReasons.size || !CAPTURE_KINDS.has(kind)) return null;
      const index = state.pending.findIndex((item) => item.kind === kind);
      if (index < 0) return null;
      const [item] = state.pending.splice(index, 1);
      state.bytes = Math.max(0, state.bytes - item.bytes);
      const { bytes: _bytes, ...withoutBytes } = item;
      return withoutBytes;
    },

    snapshot() {
      return {
        pending: state.pending.length,
        bytes: state.bytes,
        dropped: state.dropped,
        droppedByKind: { ...state.droppedByKind },
        peakPending: state.peakPending,
        peakBytes: state.peakBytes,
        inferencePaused: state.pauseReasons.size > 0,
        pauseReasons: [...state.pauseReasons].sort(),
      };
    },

    clear() {
      state.pending.length = 0;
      state.bytes = 0;
      state.dropped = 0;
      state.droppedByKind = { visual: 0, audio: 0, unknown: 0 };
      state.peakPending = 0;
      state.peakBytes = 0;
    },
  };
}

export const sharedExperienceSpoolLimits = Object.freeze({
  maxItems: DEFAULT_MAX_ITEMS,
  maxBytes: DEFAULT_MAX_BYTES,
});
