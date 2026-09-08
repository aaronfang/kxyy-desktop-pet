const NARRATED_TITLE = /(?:解说|讲解|盘点|速看|看完|剧情梳理|故事梳理|一口气|分钟看)/;

export function viewingStatementContentMode(value = "") {
  const statement = String(value || "").trim().slice(0, 240);
  if (!/^我们(?:现在|正在)?(?:一起)?(?:来|在|开始|继续)?看/u.test(statement)) return null;
  return classifySharedExperienceContentMode(statement);
}

export function classifySharedExperienceContentMode(title = "") {
  const normalized = String(title || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!normalized) return "unknown";
  return NARRATED_TITLE.test(normalized) ? "narrated" : "direct";
}

export function sharedExperienceEvidenceEmphasis({ contentMode = "unknown", audioEvents = [], visualEvents = [] } = {}) {
  if (contentMode === "narrated") return "audio-led";
  const audio = Array.isArray(audioEvents) ? audioEvents.filter((event) => String(event?.text || "").trim()).length : 0;
  const visual = Array.isArray(visualEvents) ? visualEvents.filter((event) => String(event?.summary || event?.text || "").trim()).length : 0;
  if (audio === 0 && visual > 0) return "visual-led";
  if (visual >= audio * 2) return "visual-led";
  if (audio >= visual * 2) return "audio-supported";
  return "balanced";
}
