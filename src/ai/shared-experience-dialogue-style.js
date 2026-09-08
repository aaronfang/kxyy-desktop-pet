const RULES = Object.freeze([
  ["sentence-audit", /这句(?:只|主要)?(?:是|交代|说明|表达|能确认)/u],
  ["scripted-unknown", /(?:具体|究竟).{0,12}(?:还没|尚未|没有)(?:揭晓|说明|交代|讲到|出现)/u],
  ["scripted-wait", /(?:还(?:得|要)?再等等看|等(?:到)?后面.{0,8}(?:揭晓|再说|讲到))/u],
  ["forced-av-comparison", /(?:(?:声音|旁白|解说).{0,30}画面|画面.{0,30}(?:声音|旁白|解说)).{0,20}(?:对不上|不一致|不匹配)/u],
]);

export function findSharedExperienceAuditStyle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!text) return [];
  return RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
