/** Format visible conversation history for user-facing copy/export. */
export function formatChatTranscript(history, { userName = "用户", assistantName = "角色" } = {}) {
  const userLabel = String(userName || "用户").trim() || "用户";
  const assistantLabel = String(assistantName || "角色").trim() || "角色";
  if (!Array.isArray(history)) return "";
  const lines = [];
  for (const message of history) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = String(message.content || "").trim();
    if (!content || content.startsWith("\u2063")) continue;
    const extras = [];
    if (message.imageCaption || (Array.isArray(message.images) && message.images.length)) {
      extras.push(message.imageCaption ? `[图片：${String(message.imageCaption).trim()}]` : "[图片]");
    }
    if (message.sticker?.emotion) extras.push(`[表情：${String(message.sticker.emotion).trim()}]`);
    lines.push(`${message.role === "user" ? userLabel : assistantLabel}：${[content, ...extras].filter(Boolean).join("\n")}`);
  }
  return lines.join("\n\n");
}
