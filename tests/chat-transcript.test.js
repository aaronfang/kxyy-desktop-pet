import test from "node:test";
import assert from "node:assert/strict";
import { formatChatTranscript } from "../src/ai/chat-transcript.js";

test("chat transcript labels each visible turn and omits hidden directives", () => {
  const text = formatChatTranscript([
    { role: "user", content: "你好" },
    { role: "assistant", content: "晚上好" },
    { role: "user", content: "\u2063【续说】内部指令" },
    { role: "user", content: "看这个", imageCaption: "一只猫" },
  ], { userName: "小明", assistantName: "元元" });
  assert.equal(text, "小明：你好\n\n元元：晚上好\n\n小明：看这个\n[图片：一只猫]");
  assert.doesNotMatch(text, /续说/);
});
