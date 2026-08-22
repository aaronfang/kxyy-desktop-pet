import test from "node:test";
import assert from "node:assert/strict";

import { renderUnhandledTurnError } from "../src/chat-turn-error.js";

function turnUi({ error = false } = {}) {
  const classes = new Set(error ? ["error"] : ["streaming"]);
  return {
    bubble: { textContent: "（正在看图…）" },
    row: {
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
    },
    classes,
  };
}

test("image-stage failures replace the pending caption with a visible error", () => {
  const ui = turnUi();
  assert.equal(renderUnhandledTurnError(ui.bubble, ui.row, new Error("图片格式不支持")), true);
  assert.equal(ui.bubble.textContent, "出错了：图片格式不支持");
  assert.equal(ui.classes.has("streaming"), false);
  assert.equal(ui.classes.has("error"), true);
});

test("errors already rendered by the text stream are not overwritten", () => {
  const ui = turnUi({ error: true });
  ui.bubble.textContent = "出错了：上游错误 429";
  assert.equal(renderUnhandledTurnError(ui.bubble, ui.row, new Error("duplicate")), false);
  assert.equal(ui.bubble.textContent, "出错了：上游错误 429");
});
