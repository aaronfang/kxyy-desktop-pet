const NARRATED_TITLE = /(?:解说|讲解|盘点|速看|看完|剧情梳理|故事梳理|一口气|分钟看)/;
const LIVESTREAM_TITLE = /(?:直播|直播间|live\s*stream|livestream)/i;
const CINEMATIC_TITLE = /(?:电影|正片|剧集|电视剧|动画|番剧|纪录片)/;
const GAME_TITLE = /(?:游戏|实况|通关|试玩|攻略)/;

export const SHARED_EXPERIENCE_CONTENT_MODES = Object.freeze([
  "unknown",
  "narrated",
  "cinematic",
  "livestream",
  "low-speech-game",
  "direct",
]);

export function viewingStatementContentMode(value = "") {
  const statement = String(value || "").trim().slice(0, 240);
  if (!/^我们(?:现在|正在)?(?:一起)?(?:来|在|开始|继续)?看/u.test(statement)) return null;
  return classifySharedExperienceContentMode(statement);
}

export function classifySharedExperienceContentMode(title = "") {
  const normalized = String(title || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!normalized) return "unknown";
  if (NARRATED_TITLE.test(normalized)) return "narrated";
  if (LIVESTREAM_TITLE.test(normalized)) return "livestream";
  if (CINEMATIC_TITLE.test(normalized)) return "cinematic";
  if (GAME_TITLE.test(normalized)) return "low-speech-game";
  return "direct";
}

export function sharedExperienceEvidenceEmphasis({ contentMode = "unknown", audioEvents = [], visualEvents = [] } = {}) {
  const audio = Array.isArray(audioEvents) ? audioEvents.filter((event) => String(event?.text || "").trim()).length : 0;
  const visual = Array.isArray(visualEvents) ? visualEvents.filter((event) => String(event?.summary || event?.text || "").trim()).length : 0;
  if (contentMode === "narrated") return audio > 0 ? "audio-led" : visual > 0 ? "visual-led" : "balanced";
  if (audio === 0 && visual > 0) return "visual-led";
  if (contentMode === "low-speech-game" && visual > 0) return "visual-led";
  if (visual >= audio * 2) return "visual-led";
  if (audio >= visual * 2) return "audio-supported";
  return "balanced";
}
