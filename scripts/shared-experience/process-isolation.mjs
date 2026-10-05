import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import path from "node:path";

export const MACOS_INSTALLED_APP_EXECUTABLE = "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet";

export function supportsProcessIsolation(os = platform()) {
  return os === "darwin";
}

export function findForbiddenProcesses(processTable, forbiddenExecutables) {
  const forbidden = (Array.isArray(forbiddenExecutables) ? forbiddenExecutables : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value.startsWith("/") && value.length > 1);
  if (!forbidden.length) return [];
  const matches = [];
  for (const line of String(processTable || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const executable = forbidden.find((candidate) => command === candidate || command.startsWith(`${candidate} `));
    if (pid > 1 && executable) matches.push({ pid, executable });
  }
  return matches;
}

export function findInstalledAppProcesses(processTable) {
  const matches = [];
  for (const line of String(processTable || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const executable = match[2].match(/^(\/.+?\.app\/Contents\/MacOS\/kxyy-desktop-pet)(?:\s|$)/u)?.[1];
    if (executable) matches.push({ pid: Number(match[1]), executable });
  }
  return matches;
}

export function findProjectVoiceProcesses(processTable, rootDir) {
  const scripts = ["server.py", "server_cosyvoice.py", "server_voxcpm.py"]
    .map((name) => path.join(rootDir, "scripts", "local-realtime", name));
  const matches = [];
  for (const line of String(processTable || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    if (scripts.some((script) => {
      const index = match[2].indexOf(script);
      return index > 0 && /\s/u.test(match[2][index - 1])
        && (index + script.length === match[2].length || /\s/u.test(match[2][index + script.length]));
    })) matches.push({ pid: Number(match[1]) });
  }
  return matches;
}

export function inspectForbiddenInstalledApps() {
  if (!supportsProcessIsolation()) throw new Error("installed-app process isolation is unsupported on this platform");
  const table = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000 });
  return findInstalledAppProcesses(table);
}

export function assertNoInstalledAppConflict(inspect = inspectForbiddenInstalledApps) {
  const installed = inspect();
  if (installed.length) {
    throw new Error(`安装版桌宠仍在运行 (PID: ${installed.map((item) => item.pid).join(",")})，请先手动退出再启动 dev 版`);
  }
}
