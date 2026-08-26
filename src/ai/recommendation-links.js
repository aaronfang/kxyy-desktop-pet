import { sanitizeObservationText } from "./observation.js";

const BILIBILI_RECOMMENDATION_RE = /B站|哔哩哔哩|bilibili/i;
const RECOMMENDATION_LINK_REQUEST_RE = /发我链接|把链接发来|给我链接|链接发我|发链接/i;

export function isBilibiliRecommendationQuery(text) {
  return BILIBILI_RECOMMENDATION_RE.test(String(text || ""));
}

export function isRecommendationLinkRequest(text) {
  return RECOMMENDATION_LINK_REQUEST_RE.test(String(text || ""));
}

export function safeRecommendationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return "";
    if (!/^\/video\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)) return "";
    url.hash = "";
    return url.href.slice(0, 512);
  } catch {
    return "";
  }
}

export function collectRecommendationLinks(query, candidates) {
  if (!isBilibiliRecommendationQuery(query)) return [];
  const links = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const topic = candidate?.freshTopic || candidate;
    const url = safeRecommendationUrl(topic?.canonicalUrl);
    const title = sanitizeObservationText(topic?.title, { maxChars: 120 });
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    links.push({ title, url });
    if (links.length >= 8) break;
  }
  return links;
}

export function buildRecommendationLinkPrompt(query, links) {
  if (!isRecommendationLinkRequest(query)) return "";
  const confirmed = (Array.isArray(links) ? links : [])
    .map((item) => ({
      title: sanitizeObservationText(item?.title, { maxChars: 120 }),
      url: safeRecommendationUrl(item?.url),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, 8);
  if (!confirmed.length) {
    return "\n\n# 链接能力边界\n当前没有已确认的推荐链接。请明确说暂时找不到，禁止承诺稍后翻历史或虚构链接。";
  }
  return `\n\n# 已确认的推荐链接\n只能发送以下已确认链接，不要编造其它 URL：\n${confirmed
    .map((item) => `- ${item.title}: ${item.url}`)
    .join("\n")}`;
}
