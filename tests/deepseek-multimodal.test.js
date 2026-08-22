import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeepseekMultimodalMessages,
  DEEPSEEK_VISION_MODEL,
  usesDeepseekMultimodalModel,
} from "../src/deepseek-multimodal.js";

const IMAGE = "data:image/png;base64,AAAA";

test("multimodal behavior is selected by the DeepSeek text model, not the VL provider", () => {
  assert.equal(usesDeepseekMultimodalModel({
    textProvider: "deepseek",
    textModel: DEEPSEEK_VISION_MODEL,
    vlProvider: "qwen",
  }), true);
  assert.equal(usesDeepseekMultimodalModel({
    textProvider: "deepseek",
    textModel: "deepseek-v4-flash",
    vlProvider: "deepseek",
  }), false);
  assert.equal(usesDeepseekMultimodalModel({
    textProvider: "local",
    textModel: DEEPSEEK_VISION_MODEL,
  }), false);
});

test("images keep their original chronological turn during later multimodal conversation", () => {
  const messages = [
    { role: "system", content: "persona" },
    { role: "user", content: "看看\n[图片]" },
    { role: "assistant", content: "看到了" },
    { role: "user", content: "她看起来怎么样？" },
  ];
  const result = buildDeepseekMultimodalMessages(messages, [
    { role: "user", content: "看看", images: [IMAGE] },
    { role: "assistant", content: "看到了" },
    { role: "user", content: "她看起来怎么样？" },
  ]);
  assert.equal(messages[1].content, "看看\n[图片]");
  assert.match(result[0].content, /直接观察用户消息中的图片/);
  assert.match(result[0].content, /保持既定角色的性格和口吻/);
  assert.deepEqual(result[1].content, [
    { type: "text", text: "看看" },
    { type: "image_url", image_url: { url: IMAGE } },
  ]);
  assert.equal(result[3].content, "她看起来怎么样？");
});

test("images outside bounded history are not retained or re-sent", () => {
  const messages = [{ role: "user", content: "换个话题" }];
  assert.equal(buildDeepseekMultimodalMessages(messages, [
    { role: "user", content: "换个话题" },
  ]), messages);
});

test("a current image placeholder becomes a real multimodal content part", () => {
  const result = buildDeepseekMultimodalMessages(
    [{ role: "user", content: "帮我看看\n[图片]" }],
    [{ role: "user", content: "帮我看看", images: [IMAGE] }],
  );
  assert.match(result[0].content, /直接观察用户消息中的图片/);
  assert.deepEqual(result[1].content, [
    { type: "text", text: "帮我看看" },
    { type: "image_url", image_url: { url: IMAGE } },
  ]);
});
