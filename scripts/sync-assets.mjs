// 素材同步：从 web 工程把 webmeji 角色素材同步到本桌宠工程。
// 用法：
//   node scripts/sync-assets.mjs                 # 用默认源目录
//   node scripts/sync-assets.mjs /abs/path/to/webmeji
//   SRC=/abs/path node scripts/sync-assets.mjs
//
// 默认源目录假定本工程与 kxyy_ai_clone 为同级目录。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_SRC = path.join(ROOT, "..", "kxyy_ai_clone", "web", "public", "img", "webmeji");
const SRC = process.argv[2] || process.env.SRC || DEFAULT_SRC;
const DEST = path.join(ROOT, "src", "assets", "pets");

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SRC)) die(`找不到源素材目录：${SRC}`);
fs.mkdirSync(DEST, { recursive: true });

const roster = JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "roster.json"), "utf8"));
const rosterIds = new Set(roster.pets.map((p) => p.id));

const characters = fs
  .readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (!characters.length) die(`源目录里没有角色文件夹：${SRC}`);

let copied = 0;
for (const id of characters) {
  const from = path.join(SRC, id);
  const to = path.join(DEST, id);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  const frames = fs
    .readdirSync(from, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((a) => a.name)
    .sort();
  copied += 1;
  const flag = rosterIds.has(id) ? "" : "  ⚠ 未在 shared/roster.json 中注册";
  console.log(`✓ ${id}（${frames.length} 个动作）${flag}`);
}

console.log(`\n完成：同步了 ${copied} 个角色到 ${path.relative(ROOT, DEST)}/`);

const missing = characters.filter((id) => !rosterIds.has(id));
if (missing.length) {
  console.log(
    `\n提示：新角色 [${missing.join(", ")}] 还需在 shared/roster.json 添加标签，` +
      `并在 src/pet-config.js 用 registerPet() 注册帧数/节奏后才会出现在菜单里。`,
  );
}
