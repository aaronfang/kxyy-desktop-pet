/**
 * 从人格卡 persona-card.json 构建加密语料资产 persona-assets.enc
 * 
 * 替代旧 encrypt-assets.mjs 中的 persona-assets.js 输入源，
 * 改为从 persona-cards/kxyy-yuanyuan/persona-card.json 读取人设数据。
 * 
 * userProfile (观众画像) 仍从 src/ai/persona-assets.js 提取（不在人格卡中）。
 * 
 * 用法：
 *   node scripts/build-persona-enc.mjs
 *   node scripts/build-persona-enc.mjs --card persona-cards/my-character/persona-card.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// 默认人格卡路径
const DEFAULT_CARD = path.join(ROOT, "persona-cards", "kxyy-yuanyuan", "persona-card.json");
// 旧版 assets（用于提取 userProfile）
const LEGACY_ASSETS = path.join(ROOT, "src", "ai", "persona-assets.js");
// 输出
const OUT_DIR = path.join(ROOT, "src-tauri", "assets");
const OUT = path.join(OUT_DIR, "persona-assets.enc");

// 须与 src-tauri/src/persona_assets.rs 中的 XOR_KEY 保持一致
const KEY = Buffer.from("kxyy-prompt-v1");

// ── 命令行参数 ──
const args = process.argv.slice(2);
let cardPath = DEFAULT_CARD;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--card" && args[i + 1]) {
    cardPath = path.resolve(args[++i]);
  }
}

// ── 1. 读取人格卡 ──
if (!fs.existsSync(cardPath)) {
  console.error(`✗ 找不到人格卡: ${cardPath}`);
  console.error("  请先运行: python scripts/persona-distill/tools/convert_from_assets.py");
  process.exit(1);
}

console.log(`[1/3] 读取人格卡: ${path.relative(ROOT, cardPath)}`);
const card = JSON.parse(fs.readFileSync(cardPath, "utf-8"));

// ── 2. 提取 userProfile（从独立 JSON 或 legacy assets 取） ──
const USER_PROFILE_JSON = path.join(ROOT, "persona-cards", "user-profile.json");
let userProfile = {};
if (fs.existsSync(USER_PROFILE_JSON)) {
  console.log(`[2/3] 从 ${path.relative(ROOT, USER_PROFILE_JSON)} 读取 userProfile`);
  try {
    userProfile = JSON.parse(fs.readFileSync(USER_PROFILE_JSON, "utf-8"));
  } catch (e) {
    console.warn(`  [WARN] user-profile.json 解析失败: ${e.message}，回退到旧版 assets`);
  }
}
if (!userProfile || Object.keys(userProfile).length === 0) {
  if (fs.existsSync(LEGACY_ASSETS)) {
    console.log(`[2/3] 从 persona-assets.js 提取 userProfile（旧版兼容）`);
    try {
      const mod = await import(pathToFileURL(LEGACY_ASSETS).href);
      userProfile = mod.userProfile ?? {};
    } catch (e) {
      console.warn(`  [WARN] 无法读取 userProfile: ${e.message}`);
      console.warn("         将使用空画像（不影响基本对话功能）");
    }
  } else {
    console.warn(`  [WARN] 找不到用户画像文件，userProfile 为空`);
  }
}

// ── 3. 组装 payload → XOR 加密 ──
const payload = {
  systemPrompt: card.system_prompt ?? "",
  fewShot: Array.isArray(card.few_shot) ? card.few_shot : [],
  userProfile: userProfile,
  lore: card.lore ?? {},
  corrections: card.corrections ?? {},
  personality_dimensions: card.personality_dimensions ?? null,
};

const plain = Buffer.from(JSON.stringify(payload), "utf8");
const enc = Buffer.alloc(plain.length);
for (let i = 0; i < plain.length; i++) {
  enc[i] = plain[i] ^ KEY[i % KEY.length];
}

// ── 4. 写入 ──
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, enc);

console.log(`[3/3] 加密完成 → ${path.relative(ROOT, OUT)} (${enc.length} 字节)`);

// ── 5. 打印摘要 ──
console.log("\n=== 打包摘要 ===");
console.log(`  人格卡:      ${card.meta?.name ?? "未知"} (${card.meta?.card_id ?? "?"})`);
console.log(`  版本:        ${card.meta?.version ?? "?"}`);
console.log(`  system_prompt:  ${(card.system_prompt?.length ?? 0).toLocaleString()} 字符`);
console.log(`  few_shot:       ${(card.few_shot?.length ?? 0)} 条`);
console.log(`  corrections:    ${(card.corrections?.corrections?.length ?? 0)} 条`);
const dims = card.personality_dimensions;
if (dims && typeof dims === "object") {
  const dimNames = Object.keys(dims).filter(k => !k.startsWith("_"));
  console.log(`  蒸馏维度:      ${dimNames.length} 个 (${dimNames.join(", ")})`);
} else {
  console.log(`  蒸馏维度:      (无)`);
}

console.log("\n下一步:");
console.log("  npm run tauri dev     # 开发运行（会自动调用 encrypt-assets）");
console.log("  npm run build         # 构建安装包");
