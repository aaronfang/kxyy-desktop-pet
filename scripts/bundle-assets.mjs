// 打包前临时移走明文 persona-assets.js，避免打进安装包；打包后 restore 还原。
// 用法：node scripts/bundle-assets.mjs strip | restore

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "src", "ai", "persona-assets.js");
// Keep plaintext recovery material outside frontendDist so even a bundler that
// includes dotfiles cannot copy it into the application.
const BAK = path.join(ROOT, ".persona-assets.js.bak");
const LEGACY_BAK = path.join(ROOT, "src", "ai", ".persona-assets.js.bak");

const mode = process.argv[2];
if (mode === "strip") {
  if (!fs.existsSync(ASSETS)) {
    if (fs.existsSync(BAK) || fs.existsSync(LEGACY_BAK)) {
      console.log("✓ persona-assets.js 已移走，跳过 strip");
      process.exit(0);
    }
    console.error("✗ 找不到 persona-assets.js，请先 npm run sync-ai");
    process.exit(1);
  }
  fs.renameSync(ASSETS, BAK);
  console.log("✓ 已移走明文 persona-assets.js（打包不含语料原文）");
} else if (mode === "restore") {
  const backup = fs.existsSync(BAK) ? BAK : LEGACY_BAK;
  if (fs.existsSync(backup)) {
    if (fs.existsSync(ASSETS)) fs.unlinkSync(ASSETS);
    fs.renameSync(backup, ASSETS);
    console.log("✓ 已还原 persona-assets.js");
  }
} else {
  console.error("用法: node scripts/bundle-assets.mjs strip|restore");
  process.exit(1);
}
