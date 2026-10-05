// A longer context is useful for conversational recall: ASR arrives in roughly
// five-second chunks and a single 24s slice often contains only fragments.
const WINDOW_MS = 45_000;
const BROWSER_CHROME = /浏览器|调试|地址栏|标签页|工具栏|提示条|推荐区|网页|加载(?:中|提示)|debugg?ing|address bar|browser toolbar|web\s?page/iu;

export function isBrowserChromeTopic(text) {
  return BROWSER_CHROME.test(String(text || ""));
}

export function videoQuestionEvidence(event) {
  if (event?.kind !== "visual") return event;
  const text = String(event.text || "").split(/(?<=[。！？.!?；;\n])/u)
    .filter((sentence) => !isBrowserChromeTopic(sentence)).join("").trim();
  return { ...event, text };
}

export function isQuestionEvidenceUsable(event) {
  const text = String(event?.text || "").trim();
  if ((text.match(/\p{Script=Han}/gu) || []).length < 4) {
    const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
    if (words.length < 6 || new Set(words.map((word) => word.toLowerCase())).size < 5) return false;
  }
  if (event.kind !== "audio") return true;
  if (/\b(?:to|from|with|because|and|but|the|a|an|your|our|their|any)[.!?,\s]*$/iu.test(text)) return false;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return false;
  // A punctuation mark alone does not make an interrupted ASR clause complete.
  return !/(?:所以|但|但是|为了|只因|因为|而|从而|就要|还没|他们|他|她|双方|部队|命令|就行)[。！!？?，,\s]*$/u.test(text);
}

export function buildCurrentEvidenceWindow(journal = [], { focusEvidenceIds = [] } = {}) {
  const events = (Array.isArray(journal) ? journal : [])
    .filter((event) => event && ["audio", "visual"].includes(event.kind)
      && Number.isFinite(Number(event.atMs)) && String(event.text || "").trim())
    .map((event) => ({ ...event, atMs: Number(event.atMs), text: String(event.text).slice(0, 360) }))
    .sort((a, b) => a.atMs - b.atMs);
  const ids = new Set(focusEvidenceIds);
  const focus = events.filter((event) => ids.has(event.id));
  const end = (focus.at(-1) || events.at(-1))?.atMs ?? 0;
  const recent = events.filter((event) => event.atMs <= end && event.atMs >= end - WINDOW_MS);
  const audio = recent.filter((event) => event.kind === "audio").slice(-8).map((event, index, items) => {
    const previous = items[index - 1];
    const gapBeforeMs = previous && Number.isFinite(Number(previous.endedAtMs))
      ? Math.max(0, event.atMs - Number(previous.endedAtMs)) : null;
    return { ...event, gapBeforeMs };
  });
  const visual = recent.filter((event) => event.kind === "visual").slice(-4);
  const text = [
    ...audio.map((event) => `${event.gapBeforeMs > 1000 ? `[采集空档 ${event.gapBeforeMs}ms，不补全缺失语句]\n` : ""}[${event.id}] 声音：${event.text}`),
    ...visual.map((event) => `[${event.id}] 画面：${event.text}`),
  ].join("\n");
  return { audio, visual, questionAudio: audio.filter(isQuestionEvidenceUsable), text };
}
