// 将 src/ai/persona-assets.js 序列化为 JSON 后 XOR 加密，写入 src-tauri/assets/persona-assets.enc
// 供 Rust 编译期嵌入；安装包内不再包含明文语料。
// 用法：node scripts/encrypt-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "ai", "persona-assets.js");
const OUT_DIR = path.join(ROOT, "src-tauri", "assets");
const OUT = path.join(OUT_DIR, "persona-assets.enc");

// 须与 src-tauri/src/persona_assets.rs 中的 XOR_KEY 保持一致。
const KEY = Buffer.from("kxyy-prompt-v1");

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC}，请先运行 npm run sync-ai`);
  process.exit(1);
}

const mod = await import(pathToFileURL(SRC).href);
const payload = {
  systemPrompt: mod.systemPrompt ?? "",
  fewShot: mod.fewShot ?? [],
  userProfile: mod.userProfile ?? {},
  lore: mod.lore ?? {},
  corrections: mod.corrections ?? {},
};
const plain = Buffer.from(JSON.stringify(payload), "utf8");
const enc = Buffer.alloc(plain.length);
for (let i = 0; i < plain.length; i++) {
  enc[i] = plain[i] ^ KEY[i % KEY.length];
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, enc);
console.log(`✓ 已加密语料 → src-tauri/assets/persona-assets.enc（${enc.length} 字节）`);
