export const SHARED_EXPERIENCE_CONTENT_MODES = Object.freeze([
  "unknown",
  "narrated",
  "game-narrated",
  "cinematic",
  "livestream",
  "short-video",
  "low-speech-game",
  "direct",
]);

export const SHARED_EXPERIENCE_CONTENT_MODE_LABELS = Object.freeze({
  unknown: "未选择",
  cinematic: "电影原片 / 剧集",
  narrated: "电影解说",
  "game-narrated": "游戏解说",
  livestream: "直播",
  "short-video": "短视频",
  "low-speech-game": "低语音游戏",
  direct: "其他内容",
});

export function normalizeSharedExperienceContentMode(value = "") {
  const mode = String(value || "").trim();
  return SHARED_EXPERIENCE_CONTENT_MODES.includes(mode) ? mode : "unknown";
}

export function viewingStatementContentMode(value = "") {
  const statement = String(value || "").trim().slice(0, 240);
  if (!/^我们(?:现在|正在)?(?:一起)?(?:来|在|开始|继续)?看/u.test(statement)) return null;
  return classifySharedExperienceContentMode(statement);
}

export function classifySharedExperienceContentMode(title = "", owner = "") {
  // Window metadata is intentionally not a content classification signal.
  // The user chooses the viewing context explicitly from the chat controls.
  void title;
  void owner;
  return "unknown";
}

export function sharedExperienceEvidenceEmphasis({ contentMode = "unknown", audioEvents = [], visualEvents = [] } = {}) {
  const audio = Array.isArray(audioEvents) ? audioEvents.filter((event) => String(event?.text || "").trim()).length : 0;
  const visual = Array.isArray(visualEvents) ? visualEvents.filter((event) => String(event?.summary || event?.text || "").trim()).length : 0;
  if (["narrated", "game-narrated"].includes(contentMode)) return audio > 0 ? "audio-led" : visual > 0 ? "visual-led" : "balanced";
  if (audio === 0 && visual > 0) return "visual-led";
  if (contentMode === "low-speech-game" && visual > 0) return "visual-led";
  if (visual >= audio * 2) return "visual-led";
  if (audio >= visual * 2) return "audio-supported";
  return "balanced";
}
