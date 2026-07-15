// Cross-platform: kill old realtime/TTS services before dev/build.
import { execFileSync, execSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORTS = [19876, 19976, 19877, 19977]; // Qwen3-TTS + CosyVoice WS/HTTP
const LOCAL_REALTIME_DIR = join(__dirname, "local-realtime");
const PROJECT_ROOT = resolve(__dirname, "..");
const DEBUG_EXE = join(
  PROJECT_ROOT,
  "src-tauri",
  "target",
  "debug",
  platform() === "win32" ? "kxyy-desktop-pet.exe" : "kxyy-desktop-pet",
);

/**
 * 清理上一次被 IDE/终端强制中止后残留的 dev 桌宠进程。
 * 必须按完整路径匹配，不能只按进程名清理，否则会误杀已安装的 release 版。
 */
function killStaleDevApp(isWin) {
  try {
    if (isWin) {
      const script = [
        "$target = [IO.Path]::GetFullPath($env:KXYY_DEBUG_EXE)",
        "$procs = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -eq $target) }",
        "$ids = @($procs | ForEach-Object { $_.ProcessId })",
        "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }",
        "if ($ids.Count -gt 0) { [Console]::Write(($ids -join ',')) }",
      ].join("; ");
      const pids = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, KXYY_DEBUG_EXE: DEBUG_EXE },
        },
      ).trim();
      if (pids) {
        process.stdout.write(`已停止旧 dev 桌宠进程 (PID: ${pids})\n`);
        return true;
      }
      return false;
    }

    const escaped = DEBUG_EXE.replaceAll("'", "'\\''");
    const pids = execSync(`pgrep -f '^${escaped}$' 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 3000,
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (pids.length > 0) {
      execSync(`kill -9 ${pids.join(" ")}`, { timeout: 3000 });
      process.stdout.write(`已停止旧 dev 桌宠进程 (PID: ${pids.join(",")})\n`);
      return true;
    }
  } catch (e) {
    throw new Error(`无法清理旧 dev 桌宠进程，请手动结束后重试：${e.message}`);
  }
  return false;
}

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

if (killStaleDevApp(isWin)) killedAny = true;

// 删除旧入口文件，强制 Cargo 在本次 tauri dev 中重新链接 debug 可执行文件。
// 若仍被进程占用则让 predev 直接失败，避免用户误以为运行的是最新代码。
try {
  const hadOldExe = existsSync(DEBUG_EXE);
  rmSync(DEBUG_EXE, { force: true });
  if (hadOldExe) process.stdout.write(`已删除旧 dev 可执行文件: ${DEBUG_EXE}\n`);
} catch (e) {
  throw new Error(`无法删除旧 dev 可执行文件 ${DEBUG_EXE}：${e.message}`);
}

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
