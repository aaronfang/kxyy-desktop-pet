// 打包前临时移走明文 persona-assets.js，避免打进安装包；打包后 restore 还原。
// 用法：node scripts/bundle-assets.mjs strip | restore

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "src", "ai", "persona-assets.js");
const BAK = path.join(ROOT, "src", "ai", ".persona-assets.js.bak");

const mode = process.argv[2];
if (mode === "strip") {
  if (!fs.existsSync(ASSETS)) {
    if (fs.existsSync(BAK)) {
      console.log("✓ persona-assets.js 已移走，跳过 strip");
      process.exit(0);
    }
    console.error("✗ 找不到 persona-assets.js，请先 npm run sync-ai");
    process.exit(1);
  }
  fs.renameSync(ASSETS, BAK);
  console.log("✓ 已移走明文 persona-assets.js（打包不含语料原文）");
} else if (mode === "restore") {
  if (fs.existsSync(BAK)) {
    if (fs.existsSync(ASSETS)) fs.unlinkSync(ASSETS);
    fs.renameSync(BAK, ASSETS);
    console.log("✓ 已还原 persona-assets.js");
  }
} else {
  console.error("用法: node scripts/bundle-assets.mjs strip|restore");
  process.exit(1);
}
