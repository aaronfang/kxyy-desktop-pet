const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  getSettings: () => ipcRenderer.invoke("pet:get-settings"),
  setIgnoreMouse: (ignore) => ipcRenderer.send("pet:set-ignore-mouse", ignore),
  showContextMenu: () => ipcRenderer.send("pet:show-context-menu"),
  onApplySettings: (cb) =>
    ipcRenderer.on("pet:apply-settings", (_e, data) => cb(data)),
});
