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

const testFiles = [
  "tests/test_local_realtime_events.py",
  "tests/test_qwen_mlx_stream.py",
  "tests/test_vad_adapter.py",
];

for (const [command, prefixArgs] of candidates) {
  let commandFound = true;
  for (const testFile of testFiles) {
    const result = spawnSync(command, [...prefixArgs, testFile], {
      stdio: "inherit",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    if (result.error?.code === "ENOENT") {
      commandFound = false;
      break;
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (commandFound) process.exit(0);
}

console.error("Python 3 is required to run the local realtime event tests.");
process.exit(1);
