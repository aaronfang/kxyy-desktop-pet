// AI 语音播放音量（朗读 TTS + 实时通话下行共用）。
// 线性增益：1 = 100% 原音量，最高 2（200%）。

let gain = 1;
const listeners = new Set();

/** 当前线性增益（1 = 原音量）。 */
export function getVoiceGain() {
  return gain;
}

/**
 * 设置音量百分比。
 * @param {number} percent 0–200，100 = 原音量
 */
export function setVoiceVolumePercent(percent) {
  const p = Number(percent);
  const next = Math.max(0, Math.min(2, (Number.isFinite(p) ? p : 100) / 100));
  if (next === gain) return;
  gain = next;
  for (const fn of listeners) {
    try {
      fn(gain);
    } catch {
      /* ignore */
    }
  }
}

/** 订阅增益变化；返回取消订阅函数。 */
export function onVoiceGainChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
