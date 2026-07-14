// Cross-platform: kill old realtime/TTS services before dev/build.
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORTS = [19876, 19976, 19877, 19977]; // Qwen3-TTS + CosyVoice WS/HTTP
const LOCAL_REALTIME_DIR = join(__dirname, "local-realtime");

function killPortWin(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", timeout: 3000 });
    const pids = new Set();
    for (const line of out.trim().split(/\r?\n/)) {
      // TCP  127.0.0.1:19876  0.0.0.0:0  LISTENING  12345
      const m = line.trim().split(/\s+/);
      const pid = m[m.length - 1];
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
    if (pids.size > 0) {
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }); } catch {}
      }
      process.stdout.write(`已停止端口 :${port} (PID: ${[...pids].join(",")})\n`);
      return true;
    }
  } catch { /* no match or no netstat */ }
  return false;
}

function killPortUnix(port) {
  try {
    const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: "utf8", timeout: 3000 })
      .trim()
      .split(/\n/)
      .filter(Boolean);
    if (pids.length > 0) {
      try { execSync(`kill ${pids.join(" ")}`, { timeout: 3000 }); } catch {}
      // force-kill any survivors after a short sleep
      try { execSync(`sleep 0.2 && lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill -9`, { timeout: 3000 }); } catch {}
      process.stdout.write(`已停止 :${port} (PID: ${pids.join(",")})\n`);
      return true;
    }
  } catch { /* no lsof or no match */ }
  return false;
}

// --- main ---
console.log("正在检查旧服务...");

let killedAny = false;
const isWin = platform() === "win32";

for (const port of PORTS) {
  const killed = isWin ? killPortWin(port) : killPortUnix(port);
  if (killed) killedAny = true;
}

// also kill any stale python processes that are our servers
try {
  if (isWin) {
    // Find python processes whose command line mentions server.py / server_cosyvoice.py
    try {
      const wmic = execSync(
        `wmic process where "name like '%python%'" get ProcessId,CommandLine /format:csv 2>nul`,
        { encoding: "utf8", timeout: 5000 }
      );
      const lines = wmic.trim().split(/\r?\n/);
      for (const line of lines) {
        if (line.includes("server.py") || line.includes("server_cosyvoice.py")) {
          const parts = line.split(",");
          const pid = parts[parts.length - 1]?.trim();
          if (/^\d+$/.test(pid)) {
            try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }); } catch {}
            killedAny = true;
            process.stdout.write(`已停止 python server 进程 (PID: ${pid})\n`);
          }
        }
      }
    } catch {}
  } else {
    try {
      execSync("pkill -f 'server.py|server_cosyvoice.py' 2>/dev/null || true", { timeout: 3000 });
    } catch {}
  }
} catch {}

// clean up stale .pid files
for (const f of ["qwen.pid", "cosy.pid"]) {
  try { rmSync(join(LOCAL_REALTIME_DIR, "out", f)); } catch {}
}

if (killedAny) {
  // brief wait for ports to release
  await new Promise((r) => setTimeout(r, 300));
  console.log("旧服务已清理完成。\n");
} else {
  console.log("未发现运行中的服务。\n");
}
