import test from "node:test";
import assert from "node:assert/strict";

import { findForbiddenProcesses } from "../scripts/shared-experience/process-isolation.mjs";

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
