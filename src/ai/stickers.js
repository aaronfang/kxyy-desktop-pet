/** 表情包：加载清单、按情绪挑表情（一轮内不重复）、解析回复里的 [表情:xxx] 标记。
 *  与「点歌」(songs.js) 同构：AI 在回复里用标记发起，前端解析并渲染对应 GIF 气泡。 */

const STICKERS_URL = "./stickers/stickers.json";

let manifest = null;
let byEmotion = {}; // emotion(中文) -> [sticker, ...]
let emotions = []; // 至少有一张图的情绪列表（去重、保序），用于注入系统提示
// 每个情绪一个「最近已用」列表，放完一轮才允许重复，避免老是同一张。
const recentByEmotion = {};

/** 把情绪词归一（去空格/标点）用于容错匹配。 */
function normEmotion(s) {
  return (s || "").replace(/[\s，。!！?？、,.]/g, "");
}

/** 加载表情清单（只加载一次），建立 情绪→表情 索引。 */
export async function loadStickers() {
  if (manifest) return manifest;
  try {
    const r = await fetch(STICKERS_URL, { cache: "no-cache" });
    manifest = r.ok ? await r.json() : { stickers: [] };
  } catch {
    manifest = { stickers: [] };
  }
  if (!Array.isArray(manifest.stickers)) manifest.stickers = [];
  byEmotion = {};
  emotions = [];
  for (const s of manifest.stickers) {
    const emo = (s.emotion || "").trim();
    if (!emo || !s.url) continue;
    if (!byEmotion[emo]) {
      byEmotion[emo] = [];
      emotions.push(emo);
    }
    byEmotion[emo].push(s);
  }
  return manifest;
}

/** 当前可用的情绪清单（仅含至少有一张图的情绪），供系统提示注入；AI 只能从中选。 */
export function stickerEmotions() {
  return emotions.slice();
}

/** 用户「表情库」可选的全部表情，平铺返回（保序）；排除标记为「仅元元发」(aiOnly) 的表情，
 *  让那些表情成为元元专属、用户列表里没有，聊天更真实。 */
export function userStickers() {
  const out = [];
  for (const emo of emotions) {
    for (const s of byEmotion[emo]) {
      if (s.aiOnly) continue;
      out.push(s);
    }
  }
  return out;
}

/** 把一条原始 sticker 记录归一成发送/渲染用的精简对象（与 pickSticker 返回结构一致）。 */
export function toSticker(s) {
  if (!s || !s.url) return null;
  return {
    file: s.file,
    url: s.url,
    emotion: (s.emotion || "").trim(),
    width: s.width,
    height: s.height,
  };
}

/** 按情绪挑一张表情（一轮内不重复）；找不到该情绪返回 null。 */
export function pickSticker(emotion) {
  const emo = (emotion || "").trim();
  if (!emo) return null;
  let key = byEmotion[emo] ? emo : null;
  if (!key) {
    // 容错：去掉空格/标点后再找一次完全匹配（如 "卖萌。" → "卖萌"）。
    const n = normEmotion(emo);
    key = emotions.find((e) => normEmotion(e) === n) || null;
  }
  const pool = key ? byEmotion[key] : null;
  if (!pool || !pool.length) return null;

  const recent = recentByEmotion[key] || [];
  let candidates = pool.filter((s) => !recent.includes(s.file));
  if (!candidates.length) {
    recentByEmotion[key] = [];
    candidates = pool;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  recentByEmotion[key] = [...(recentByEmotion[key] || []), pick.file];
  return {
    file: pick.file,
    url: pick.url,
    emotion: key,
    width: pick.width,
    height: pick.height,
  };
}

// AI 回复里「发一张表情」的标记：[表情:卖萌] / [表情：卖萌]（中英文冒号都认）。
const STICKER_RE = /\[表情[:：]\s*([^\]]+?)\s*\]/g;
// 流式过程中，结尾可能是还没收全的半个标记（如 "[表情:卖" 或 "[表情"），显示时一并去掉。
const STICKER_TAIL_RE = /\[表情[:：]?[^\]]*$/;

/**
 * 从整条回复里提取首个表情标记，并返回去掉所有标记后的纯文本。
 * @returns {{ text: string, emotion: (string|null) }}
 */
export function extractSticker(text) {
  const raw = text || "";
  let emotion = null;
  const cleaned = raw
    .replace(STICKER_RE, (_, e) => {
      if (!emotion) emotion = (e || "").trim();
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, emotion };
}

/** 流式显示用：去掉已完成标记 + 末尾未收全的半个标记，避免把 [表情:..] 闪给用户看。 */
export function stripStickerForDisplay(text) {
  return (text || "").replace(STICKER_RE, "").replace(STICKER_TAIL_RE, "");
}
