const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingDesktop", {
  downloadAudio: (url) => ipcRenderer.invoke("desktop:download-audio", url),
  getBootstrap: () => ipcRenderer.invoke("desktop:get-bootstrap"),
  saveConfig: (config) => ipcRenderer.invoke("desktop:save-config", config),
  getWindowState: () => ipcRenderer.invoke("desktop:get-window-state"),
  minimizeWindow: () => ipcRenderer.invoke("desktop:minimize-window"),
  toggleMaximize: () => ipcRenderer.invoke("desktop:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("desktop:close-window"),
  respondCloseWindow: (action) =>
    ipcRenderer.invoke("desktop:respond-close-window", action),
  minimizeToTray: () => ipcRenderer.invoke("desktop:minimize-to-tray"),
  closeApp: () => ipcRenderer.invoke("desktop:close-app"),
  openMinutesWindow: (payload) =>
    ipcRenderer.invoke("desktop:open-minutes-window", payload),
  getMinutesPayload: () => ipcRenderer.invoke("desktop:get-minutes-payload"),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desktop:close-requested", listener);
    ipcRenderer.send("desktop:close-dialog-ready");
    return () => ipcRenderer.removeListener("desktop:close-requested", listener);
  },
  onWindowStateChange: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("desktop:window-state", listener);
    return () => ipcRenderer.removeListener("desktop:window-state", listener);
  },
  onMinutesPayload: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on("minutes:payload", listener);
    return () => ipcRenderer.removeListener("minutes:payload", listener);
  },
});
