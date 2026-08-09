export const BASE_TOPIC_CATEGORIES = Object.freeze([
  { id: "film-tv", label: "电影影视" },
  { id: "games", label: "游戏" },
  { id: "technology", label: "科技数码" },
  { id: "music", label: "音乐" },
  { id: "food", label: "美食" },
  { id: "travel", label: "旅行" },
  { id: "books", label: "读书" },
  { id: "sports", label: "运动" },
  { id: "work-growth", label: "工作成长" },
  { id: "daily-life", label: "日常生活" },
]);

const VALID_STATUSES = new Set(["interested", "not-interested", "neutral"]);
const MAX_ENTRIES = 32;
const MAX_TOPIC_CHARS = 32;

const INFERENCE_TOPICS = Object.freeze([
  ["电影影视", /电影|影视|院线|票房|科幻片|电视剧|影片|片子|剧集|新片|追剧|movie|film/i],
  ["游戏", /游戏|电竞|手游|端游|主机游戏|新游|限免|steam|xbox|playstation|gaming/i],
  ["科技数码", /科技|人工智能|AI|芯片|手机|数码|软件|technology/i],
  ["音乐", /音乐|歌曲?|歌单|新歌|歌手|专辑|单曲|乐队|演唱会|听歌|music/i],
  ["美食", /美食|吃饭|料理|餐厅|餐馆|饭店|好吃的|吃什么|探店|小吃|烹饪|food/i],
  ["旅行", /旅行|旅游|景点|出游|去哪儿?玩|周边游|度假|travel/i],
  ["读书", /读书|阅读|小说|书籍?|书单|新书|好书|网文|books?/i],
  ["运动", /运动|健身|跑步|球赛|体育|篮球|足球|羽毛球|乒乓球|sports?/i],
  ["工作成长", /工作|职场|求职|招聘|岗位|学习|成长|职业|效率/i],
  ["日常生活", /日常|生活|家务|天气|健康|作息|养生|通勤/i],
]);
const INFERENCE_POSITIVE_RE = /喜欢|很爱|热爱|感兴趣|想多聊|想聊聊|最爱|特别爱|对.+有兴趣/i;
const INFERENCE_NEGATIVE_RE = /不喜欢|不太喜欢|讨厌|没兴趣|不感兴趣|别主动聊|不要主动聊|不想聊|不聊/i;
const INFERENCE_NEUTRAL_RE = /恢复中立|改成中立|都可以|无所谓|没那么在意|不特别偏好/i;

function cleanTopic(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TOPIC_CHARS);
}

function normalizeSource(value) {
  return value === "inferred" ? "inferred" : "manual";
}

/**
 * 只从用户明确表达的偏好句推断候选；沉默、短回复和模型生成文本永不触发。
 * evidence 是固定枚举，不保存原话，候选必须由用户在设置页确认或编辑。
 */
export function inferTopicPreferenceCandidates(text) {
  const value = String(text || "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!value || value.length > 512) return [];
  const result = [];
  for (const [topic, pattern] of INFERENCE_TOPICS) {
    const match = value.match(pattern);
    if (!match) continue;
    const start = Math.max(0, (match.index || 0) - 24);
    const context = value.slice(start, Math.min(value.length, (match.index || 0) + match[0].length + 24));
    let status = "";
    let evidence = "";
    if (INFERENCE_NEUTRAL_RE.test(context)) {
      status = "neutral";
      evidence = "explicit-neutral";
    } else if (INFERENCE_NEGATIVE_RE.test(context)) {
      status = "not-interested";
      evidence = "explicit-negative";
    } else if (INFERENCE_POSITIVE_RE.test(context)) {
      status = "interested";
      evidence = "explicit-positive";
    }
    if (!status) continue;
    result.push({ topic, status, source: "inferred", confidence: "high", evidence });
  }
  return result.slice(0, 3);
}

export function normalizeTopicPreferences(entries) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  const positions = new Map();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const topic = cleanTopic(raw.topic);
    const status = VALID_STATUSES.has(raw.status) ? raw.status : "";
    if (!topic || !status) continue;
    const source = normalizeSource(raw.source);
    const key = topic.toLocaleLowerCase();
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, result.length);
      result.push({
        topic,
        status,
        source,
        ...(typeof raw.confidence === "string" ? { confidence: raw.confidence.slice(0, 16) } : {}),
        ...(typeof raw.evidence === "string" ? { evidence: raw.evidence.slice(0, 32) } : {}),
      });
    } else {
      const previous = result[index];
      if (previous.source === "manual" && source === "inferred") continue;
      result[index] = {
        topic,
        status,
        source,
        ...(typeof raw.confidence === "string" ? { confidence: raw.confidence.slice(0, 16) } : {}),
        ...(typeof raw.evidence === "string" ? { evidence: raw.evidence.slice(0, 32) } : {}),
      };
    }
  }
  return result.slice(0, MAX_ENTRIES);
}

export function buildTopicPreferencePrompt(entries) {
  const normalized = normalizeTopicPreferences(entries);
  if (!normalized.length) return "";
  const manual = normalized.filter((entry) => entry.source === "manual");
  const inferred = normalized.filter((entry) => entry.source === "inferred");
  const interested = manual.filter((entry) => entry.status === "interested").map((entry) => entry.topic);
  const avoid = manual.filter((entry) => entry.status === "not-interested").map((entry) => entry.topic);
  const inferredInterested = inferred
    .filter((entry) => entry.status === "interested")
    .map((entry) => entry.topic);
  const inferredAvoid = inferred
    .filter((entry) => entry.status === "not-interested")
    .map((entry) => entry.topic);
  const lines = [
    "# 话题偏好（仅用于带聊方向，用户手动设置优先）",
    "- 不感兴趣只限制你主动发起；用户主动提到时仍正常回应。",
    "- 中立或没有偏好的话题不要强行解释，也不要把它当作禁聊。",
  ];
  if (interested.length) lines.push(`- 用户手动感兴趣：${interested.join("、")}`);
  if (avoid.length) lines.push(`- 用户手动不要主动发起：${avoid.join("、")}`);
  if (inferredInterested.length) lines.push(`- 推测的兴趣候选：${inferredInterested.join("、")}（仅作弱提示）`);
  if (inferredAvoid.length) lines.push(`- 推测的回避候选：${inferredAvoid.join("、")}（仅作弱提示）`);
  lines.push("- 不要复述这份设置；它不能覆盖用户当下明确说的话。");
  return lines.join("\n");
}

export const TOPIC_PREFERENCE_STATUSES = Object.freeze([
  { value: "interested", label: "感兴趣" },
  { value: "neutral", label: "中立" },
  { value: "not-interested", label: "不主动聊" },
]);
