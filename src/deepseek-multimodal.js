export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
const DIRECT_VISION_HINT = `# 多模态看图
请直接观察用户消息中的图片，并保持既定角色的性格和口吻回应：先抓住图里的重点，再自然调侃、共情或追问；不要只复述画面，也不要报告分辨率或技术参数。`;

export function usesDeepseekMultimodalModel(settings) {
  return settings?.textProvider === "deepseek" && settings?.textModel === DEEPSEEK_VISION_MODEL;
}

function boundedImageGroups(history) {
  return (history || [])
    .filter((message) => message?.role === "user" && Array.isArray(message.images))
    .map((message) => message.images.filter(
      (value) => String(value || "").startsWith("data:image/"),
    ))
    .filter((images) => images.length > 0);
}

/** Restore images at their original user turns while they remain in bounded live context. */
export function buildDeepseekMultimodalMessages(messages, boundedHistory) {
  const imageGroups = boundedImageGroups(boundedHistory);
  if (!imageGroups.length) return messages;

  const result = (messages || []).map((message) => ({ ...message }));
  const markerIndexes = result
    .map((message, index) => message?.role === "user"
      && typeof message.content === "string"
      && /(?:\n)?\[图片\]\s*$/u.test(message.content)
      ? index
      : -1)
    .filter((index) => index >= 0)
    .slice(-imageGroups.length);
  const groups = imageGroups.slice(-markerIndexes.length);
  if (!markerIndexes.length) return messages;

  for (const [groupIndex, i] of markerIndexes.entries()) {
    const rawText = typeof result[i].content === "string" ? result[i].content : "";
    const text = rawText.replace(/(?:\n)?\[图片\]\s*$/u, "").trim();
    result[i].content = [
      ...(text ? [{ type: "text", text }] : []),
      ...groups[groupIndex].map((url) => ({ type: "image_url", image_url: { url } })),
    ];
  }
  const systemIndex = result.findIndex((message) => message?.role === "system");
  if (systemIndex >= 0) {
    result[systemIndex].content = `${result[systemIndex].content || ""}\n\n${DIRECT_VISION_HINT}`;
  } else {
    result.unshift({ role: "system", content: DIRECT_VISION_HINT });
  }
  return result;
}
