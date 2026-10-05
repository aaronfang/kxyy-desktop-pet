import test from "node:test";
import assert from "node:assert/strict";

import { assertNoInstalledAppConflict, findForbiddenProcesses, findInstalledAppProcesses, findProjectVoiceProcesses, supportsProcessIsolation } from "../scripts/shared-experience/process-isolation.mjs";

test("unsupported platforms cannot claim a clean isolation check", () => {
  assert.equal(supportsProcessIsolation("darwin"), true);
  assert.equal(supportsProcessIsolation("win32"), false);
  assert.equal(supportsProcessIsolation("linux"), false);
});

test("process isolation matches the installed executable path but not the dev binary name", () => {
  const table = `  101 /Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet\n  102 /Users/me/repo/src-tauri/target/debug/kxyy-desktop-pet\n  103 /bin/zsh -c kxyy-desktop-pet`;
  assert.deepEqual(findForbiddenProcesses(table, ["/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet"]), [{
    pid: 101,
    executable: "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet",
  }]);
});

test("process isolation rejects broad or relative forbidden paths", () => {
  assert.deepEqual(findForbiddenProcesses("1 /Applications/App", ["App", "/", ""]), []);
});

test("dev startup rejects an installed-app conflict without terminating it", () => {
  const installed = [{ pid: 4242, executable: "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet" }];
  assert.throws(() => assertNoInstalledAppConflict(() => installed), /PID: 4242/);
  assert.doesNotThrow(() => assertNoInstalledAppConflict(() => []));
  assert.deepEqual(installed, [{ pid: 4242, executable: "/Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet" }]);
});

test("installed app detection covers relocated bundles but excludes the dev binary", () => {
  const table = `  101 /Applications/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet\n  102 /Users/me/Apps/元元桌宠.app/Contents/MacOS/kxyy-desktop-pet\n  103 /Users/me/repo/src-tauri/target/debug/kxyy-desktop-pet`;
  assert.deepEqual(findInstalledAppProcesses(table).map(({ pid }) => pid), [101, 102]);
});

test("voice cleanup selects only this repository's Python servers", () => {
  const root = "/Users/me/repo";
  const table = `  101 /opt/python /Users/me/repo/scripts/local-realtime/server_voxcpm.py\n  102 /opt/python /Users/other/repo/scripts/local-realtime/server_voxcpm.py\n  103 /opt/python /Users/me/repo/scripts/mage-vl/server.py\n  104 /opt/python /Users/me/repo/scripts/local-realtime/server.py\n  105 /opt/python /Users/me/repo/scripts/local-realtime/server.py.backup`;
  assert.deepEqual(findProjectVoiceProcesses(table, root).map(({ pid }) => pid), [101, 104]);
});
