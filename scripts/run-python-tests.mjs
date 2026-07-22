import { spawnSync } from "node:child_process";

const candidates =
  process.platform === "win32"
    ? [
        ["python", []],
        ["py", ["-3"]],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

for (const [command, prefixArgs] of candidates) {
  const result = spawnSync(command, [...prefixArgs, "tests/test_local_realtime_events.py"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  if (result.error?.code === "ENOENT") continue;
  process.exit(result.status ?? 1);
}

console.error("Python 3 is required to run the local realtime event tests.");
process.exit(1);
