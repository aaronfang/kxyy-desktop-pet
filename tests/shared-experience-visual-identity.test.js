import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVisualCharacterDescriptors,
  filterVisualIdentityClaims,
} from "../src/ai/shared-experience-visual-identity.js";

test("visual identity gate drops guessed work and character identities", () => {
  assert.deepEqual(filterVisualIdentityClaims("这是动漫《进击的巨人》中的艾伦。"), {
    summary: "",
    identityFiltered: true,
  });
  assert.deepEqual(filterVisualIdentityClaims("画面中的角色来自游戏原神。"), {
    summary: "",
    identityFiltered: true,
  });
  assert.deepEqual(filterVisualIdentityClaims("艾伦正在挥刀。"), {
    summary: "",
    identityFiltered: true,
  });
  assert.deepEqual(filterVisualIdentityClaims("画面展示的是进击的巨人动画场景。"), {
    summary: "",
    identityFiltered: true,
  });
  assert.deepEqual(filterVisualIdentityClaims("卡特琳娜@海德海姆三系改造"), {
    summary: "",
    identityFiltered: true,
  });
});

test("visual identity gate keeps observable generic actions and removes only tainted clauses", () => {
  assert.deepEqual(filterVisualIdentityClaims("一名黑发男子正在挥刀。"), {
    summary: "一名黑发男子正在挥刀。",
    identityFiltered: false,
  });
  assert.deepEqual(filterVisualIdentityClaims("这是《火影忍者》里的鸣人，一名男子随后跳上屋顶。"), {
    summary: "一名男子随后跳上屋顶。",
    identityFiltered: true,
  });
});

test("visual character extraction returns observable anonymous descriptors only", () => {
  assert.deepEqual(
    extractVisualCharacterDescriptors("一名黑发男子穿深色外套站在门前，旁边有一名戴眼镜的短发女子。"),
    ["黑发男子穿深色外套", "戴眼镜的短发女子"],
  );
  assert.deepEqual(extractVisualCharacterDescriptors("程肖宇拿着剑站在门前。"), []);
});
