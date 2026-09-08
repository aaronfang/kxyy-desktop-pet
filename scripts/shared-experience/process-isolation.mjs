import { execFileSync } from "node:child_process";
import { platform } from "node:os";

export const MACOS_INSTALLED_APP_EXECUTABLE = "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet";

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

export function inspectForbiddenInstalledApps() {
  if (platform() !== "darwin") return [];
  const table = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000 });
  return findForbiddenProcesses(table, [MACOS_INSTALLED_APP_EXECUTABLE]);
}

export function stopForbiddenInstalledApps() {
  const matches = inspectForbiddenInstalledApps();
  for (const match of matches) {
    try { process.kill(match.pid, "SIGTERM"); } catch {}
  }
  return matches;
}
