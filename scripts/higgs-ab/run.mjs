import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const localPython = process.platform === "win32"
  ? path.join(here, ".venv-windows", "Scripts", "python.exe")
  : path.join(here, ".venv-macos", "bin", "python");
const candidates = existsSync(localPython)
  ? [[localPython, []]]
  : process.platform === "win32"
    ? [["python", []], ["py", ["-3"]]]
    : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const result = spawnSync(
    command,
    [...prefix, path.join(here, "benchmark.py"), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    },
  );
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
console.error("Python 3 is required. Run the platform setup script first.");
process.exit(1);
