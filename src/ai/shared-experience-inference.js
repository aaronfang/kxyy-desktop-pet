export async function withSharedExperienceInferencePaused({
  enabled,
  spool,
  reason = "tts",
  task,
  onResumed,
} = {}) {
  if (typeof task !== "function") throw new TypeError("task is required");
  if (!enabled || !spool) return task();
  spool.pauseInference(reason);
  try {
    return await task();
  } finally {
    spool.resumeInference(reason);
    onResumed?.();
  }
}
