/** Render failures from stages that run before the text stream creates its own error bubble. */
export function renderUnhandledTurnError(streamBubble, streamRow, error) {
  if (!streamBubble || !streamRow?.classList || streamRow.classList.contains("error")) {
    return false;
  }
  const message = error?.message || String(error || "未知错误");
  streamRow.classList.remove("streaming");
  streamRow.classList.add("error");
  streamBubble.textContent = `出错了：${message}`;
  return true;
}
