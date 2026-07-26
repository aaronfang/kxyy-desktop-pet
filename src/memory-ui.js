/** Memory v3 前端纯逻辑：不依赖 DOM/Tauri，供聊天与设置页复用和测试。 */

export function asksNotToRemember(text) {
  return /(别|不要|不用)(记|记住|保存)(这段|这个|这件事|刚才|这些)?|别把.{0,12}(记下来|存下来)/u.test(text || "");
}

export function memoryHealthState(status = {}) {
  const pending = Math.max(0, Number(status.pendingJobs) || 0);
  const skipped = Math.max(0, Number(status.skippedJobs) || 0);
  const error = String(status.lastError || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (status.available === false) {
    return {
      kind: "error",
      text: `记忆数据库暂不可用${error ? `：${error}` : ""}。聊天仍可继续，恢复后再处理记忆。`,
    };
  }
  if (error) {
    return {
      kind: "error",
      text: `后台巩固暂未完成：${error}。聊天不受影响，系统会自动重试。`,
    };
  }
  if (skipped > 0) {
    return {
      kind: "error",
      text: `有 ${skipped} 批会话在保留期内始终无法巩固，原始内容已按隐私策略清除。`,
    };
  }
  if (pending > 0) {
    return {
      kind: "pending",
      text: `有 ${pending} 批会话正在后台巩固或等待重试，不会阻塞聊天和退出。`,
    };
  }
  return null;
}
