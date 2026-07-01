// 从 build/icon.png 生成 Windows 用的多尺寸 build/icon.ico。
// 依赖：png-to-ico（纯 JS）+ macOS 自带 sips 做缩放。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "build", "icon.png");
const OUT = path.join(ROOT, "build", "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(SRC)) {
  console.error(`找不到源图：${SRC}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ico-"));
const pngs = SIZES.map((s) => {
  const p = path.join(tmp, `icon_${s}.png`);
  execFileSync("sips", ["-z", String(s), String(s), SRC, "--out", p], { stdio: "ignore" });
  return p;
});

const buf = await pngToIco(pngs);
fs.writeFileSync(OUT, buf);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${SIZES.join("/")} px，${buf.length} 字节）`);
