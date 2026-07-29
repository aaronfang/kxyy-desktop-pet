import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/run-python-tool.mjs <script.py> [...args]");
  process.exit(2);
}

const candidates = process.platform === "win32"
  ? [["python", []], ["py", ["-3"]]]
  : [["python3", []], ["python", []]];

for (const [command, prefixArgs] of candidates) {
  const result = spawnSync(command, [...prefixArgs, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error("Python 3 is required to run this tool.");
process.exit(1);
