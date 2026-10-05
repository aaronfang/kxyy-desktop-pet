const DEFAULT_STARTUP_SAMPLES = 5760; // 240 ms at 24 kHz, matching realtime playback.
const DEFAULT_COMPANION_STARTUP_SAMPLES = 8640; // 360 ms: absorb short local TTS generation stalls.
const DEFAULT_MAX_SCHEDULED_SAMPLES = 72000; // 3 seconds at 24 kHz.

function decodePcm16(bytes, carry) {
  const combined = new Uint8Array(bytes.length + (carry == null ? 0 : 1));
  let offset = 0;
  if (carry != null) combined[offset++] = carry;
  combined.set(bytes, offset);
  const usable = combined.length - (combined.length % 2);
  const samples = new Int16Array(usable / 2);
  const view = new DataView(combined.buffer, combined.byteOffset, usable);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return {
    samples,
    carry: usable < combined.length ? combined[combined.length - 1] : null,
  };
}

function joinSamples(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const joined = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export async function consumePcm16Stream(response, {
  startupSamples = DEFAULT_STARTUP_SAMPLES,
  maxScheduledSamples = DEFAULT_MAX_SCHEDULED_SAMPLES,
  sampleRate = 24000,
  nowSeconds = () => performance.now() / 1000,
  schedule,
  signal = null,
} = {}) {
  if (!response?.body?.getReader) throw new Error("浏览器不支持流式语音响应");
  if (typeof schedule !== "function") throw new TypeError("schedule is required");
  const reader = response.body.getReader();
  const reservoir = [];
  let reservoirSamples = 0;
  let carry = null;
  let started = false;
  const pendingPlayback = [];
  let pendingSamples = 0;
  let suppliedUntilSeconds = null;
  let underrunCount = 0;
  let maxGapMs = 0;

  const waitForOldestPlayback = async () => {
    const oldest = pendingPlayback.shift();
    if (!oldest) return;
    await oldest.completion;
    pendingSamples -= oldest.samples;
  };

  const emit = async (samples) => {
    if (!samples.length) return;
    while (pendingPlayback.length && pendingSamples + samples.length > maxScheduledSamples) {
      await waitForOldestPlayback();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
    const arrivedAtSeconds = Number(nowSeconds()) || 0;
    const scheduled = schedule(samples);
    const hasPlaybackTiming = Number.isFinite(scheduled?.startAtSeconds)
      && Number.isFinite(scheduled?.endAtSeconds)
      && scheduled.endAtSeconds >= scheduled.startAtSeconds;
    const startAtSeconds = hasPlaybackTiming ? scheduled.startAtSeconds : arrivedAtSeconds;
    if (suppliedUntilSeconds !== null && startAtSeconds > suppliedUntilSeconds) {
      underrunCount += 1;
      maxGapMs = Math.max(maxGapMs, (startAtSeconds - suppliedUntilSeconds) * 1000);
    }
    suppliedUntilSeconds = hasPlaybackTiming ? scheduled.endAtSeconds
      : Math.max(suppliedUntilSeconds ?? arrivedAtSeconds, arrivedAtSeconds)
      + samples.length / Math.max(1, Number(sampleRate) || 24000);
    const completion = hasPlaybackTiming ? scheduled.completion : scheduled;
    if (completion && typeof completion.then === "function") {
      pendingPlayback.push({ samples: samples.length, completion: Promise.resolve(completion) });
      pendingSamples += samples.length;
    }
  };

  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      const decoded = decodePcm16(value, carry);
      carry = decoded.carry;
      if (!decoded.samples.length) continue;
      if (!started) {
        reservoir.push(decoded.samples);
        reservoirSamples += decoded.samples.length;
        if (reservoirSamples < startupSamples) continue;
        await emit(joinSamples(reservoir, reservoirSamples));
        reservoir.length = 0;
        reservoirSamples = 0;
        started = true;
      } else {
        await emit(decoded.samples);
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (carry != null) throw new Error("流式 PCM 响应长度不是偶数");
    if (!started && reservoirSamples) {
      await emit(joinSamples(reservoir, reservoirSamples));
      started = true;
    }
    if (!started) throw new Error("流式 TTS 未返回音频");
    while (pendingPlayback.length) await waitForOldestPlayback();
    return {
      underrunCount,
      maxGapMs: Math.round(maxGapMs),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export { DEFAULT_COMPANION_STARTUP_SAMPLES, DEFAULT_MAX_SCHEDULED_SAMPLES, DEFAULT_STARTUP_SAMPLES };
