// AI 逻辑模块同步：从 kxyy_ai_clone 把可原样复用的纯逻辑模块 + 人设语料 + 表情素材同步到本工程。
// 用法：
//   node scripts/sync-ai.mjs                       # 用默认源目录（同级 ../kxyy_ai_clone）
//   node scripts/sync-ai.mjs /abs/path/to/kxyy_ai_clone
//   SRC=/abs/path node scripts/sync-ai.mjs
//
// 只同步「内容/纯逻辑」文件；本工程自写的浮层 UI（chat.*）与 Rust 代理需手动跟随上游 /api 契约变化。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_SRC = path.join(ROOT, "..", "kxyy_ai_clone");
const SRC = process.argv[2] || process.env.SRC || DEFAULT_SRC;
const DEST = path.join(ROOT, "src", "ai");
const STICKER_DEST = path.join(ROOT, "src", "stickers");

// [源相对路径, 目标文件名] —— 原样复制的纯逻辑/语料模块。
// 注：persona.js / tts.js 内部用相对 fetch("/api/...")，桌面端由 src/chat.js 的全局 fetch
// 改写转发到本地 Rust 代理，故此处原样复制、无需改写。
const FILES = [
  ["web/public/js/persona.js", "persona.js"],
  ["web/public/js/tts.js", "tts.js"],
  ["web/lib/persona-assets.js", "persona-assets.js"],
];

// 表情系统：源码里 loadStickers() 走 fetch("/data/stickers.json")，桌面端没有该路由，
// 复制后把清单地址改成随包下发的相对路径 stickers/stickers.json。
const STICKERS_JS = ["web/public/js/stickers.js", "stickers.js"];
const STICKERS_JSON = "web/public/data/stickers.json";
const STICKERS_IMG_DIR = "web/public/img/stickers";

function die(msg) {
  console.error(`\u2717 ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SRC)) die(`找不到源工程目录：${SRC}`);
fs.mkdirSync(DEST, { recursive: true });
fs.mkdirSync(STICKER_DEST, { recursive: true });

let copied = 0;
for (const [rel, name] of FILES) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) {
    console.warn(`\u26a0 源文件不存在，跳过：${rel}`);
    continue;
  }
  fs.copyFileSync(from, path.join(DEST, name));
  copied += 1;
  console.log(`\u2713 ${rel}  \u2192  src/ai/${name}`);
}

// 1) 复制 stickers.js 并把清单 URL 改为相对路径。
{
  const from = path.join(SRC, STICKERS_JS[0]);
  if (fs.existsSync(from)) {
    let code = fs.readFileSync(from, "utf8");
    code = code.replace(/["']\/data\/stickers\.json["']/, '"./stickers/stickers.json"');
    fs.writeFileSync(path.join(DEST, STICKERS_JS[1]), code);
    copied += 1;
    console.log(`\u2713 ${STICKERS_JS[0]}  \u2192  src/ai/${STICKERS_JS[1]}（已改写清单地址）`);
  } else {
    console.warn(`\u26a0 源文件不存在，跳过：${STICKERS_JS[0]}`);
  }
}

// 2) 复制表情清单，并把每条 url 改写成相对包内路径 stickers/<file>。
let stickerCount = 0;
{
  const from = path.join(SRC, STICKERS_JSON);
  if (fs.existsSync(from)) {
    const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
    for (const s of manifest.stickers || []) {
      if (s.file) s.url = `stickers/${s.file}`;
    }
    fs.writeFileSync(
      path.join(STICKER_DEST, "stickers.json"),
      JSON.stringify(manifest, null, 2),
    );
    stickerCount = (manifest.stickers || []).length;
    console.log(`\u2713 ${STICKERS_JSON}  \u2192  src/stickers/stickers.json（${stickerCount} 条）`);
  } else {
    console.warn(`\u26a0 表情清单不存在，跳过：${STICKERS_JSON}`);
  }
}

// 3) 复制全部表情图（gif）。
let gifCount = 0;
{
  const dir = path.join(SRC, STICKERS_IMG_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(gif|png|webp)$/i.test(f)) continue;
      fs.copyFileSync(path.join(dir, f), path.join(STICKER_DEST, f));
      gifCount += 1;
    }
    console.log(`\u2713 ${STICKERS_IMG_DIR}/*  \u2192  src/stickers/（${gifCount} 张图）`);
  } else {
    console.warn(`\u26a0 表情素材目录不存在，跳过：${STICKERS_IMG_DIR}`);
  }
}

console.log(`\n完成：同步了 ${copied} 个 AI 模块、${stickerCount} 条表情清单、${gifCount} 张表情图。`);
console.log(
  "提示：若上游改了 /api/chat 请求或响应契约，需同步更新 src-tauri/src/api.rs 与 src/chat.js。",
);
console.log("提示：同步语料后请运行 npm run encrypt-assets，将人设资料加密进 Rust 二进制。");
