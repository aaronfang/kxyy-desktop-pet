import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const chatCss = fs.readFileSync(new URL("src/chat.css", root), "utf8");

test("shared-experience overlays stay fixed when they are direct chat children", () => {
  for (const id of ["shared-experience-picker", "shared-experience-debug"]) {
    const selector = new RegExp(
      `#chat\\s*>\\s*#${id}\\s*\\{[^}]*position:\\s*fixed;[^}]*inset:\\s*0;`,
      "s",
    );
    assert.match(chatCss, selector, `${id} must override the generic #chat > * positioning rule`);
    assert.match(
      chatCss,
      new RegExp(`#chat\\s*>\\s*#${id}\\[hidden\\]\\s*\\{[^}]*display:\\s*none;`, "s"),
      `${id} must remain hidden when its direct-child selector becomes more specific`,
    );
  }
});
