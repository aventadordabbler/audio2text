const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  session,
} = require("electron");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const iconPath = path.join(__dirname, "..", "assets", "icon.png");

const DEFAULT_CONFIG = {
  meetingTitle: "",
  stt: {
    baseUrl: "http://127.0.0.1:8000",
    protocol: "audio2text",
    language: "Chinese",
  },
  chunkSeconds: 1,
};

let mainWindow = null;
let minutesWindow = null;
let tray = null;
let pendingMinutesPayload = null;
let rendererSession;
let isQuitting = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getStorePath() {
  return path.join(app.getPath("userData"), "meeting-float-desktop-store.json");
}

// Only connection preferences are persisted. Meeting content lives on the server.
function normalizeConfig(value = {}) {
  return {
    ...clone(DEFAULT_CONFIG),
    stt: {
      baseUrl: value.stt?.baseUrl ?? DEFAULT_CONFIG.stt.baseUrl,
      protocol: "audio2text",
      language: value.stt?.language ?? DEFAULT_CONFIG.stt.language,
    },
    chunkSeconds: 1,
  };
}

function readStore() {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) return { config: normalizeConfig() };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return { config: normalizeConfig() };
  }
  const store = { config: normalizeConfig(parsed.config) };
  // Remove legacy local records and saved meeting titles on upgrade.
  if (JSON.stringify(parsed) !== JSON.stringify(store)) writeStore(store);
  return store;
}

function writeStore(nextStore) {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
  fs.writeFileSync(getStorePath(), JSON.stringify(nextStore, null, 2), "utf8");
}

function getBootstrapData() {
  return {
    config: readStore().config,
    platform: process.platform,
    versions: process.versions,
    autotest:
      process.argv.includes("--autotest") ||
      process.env.MEETING_FLOAT_AUTOTEST === "1",
  };
}

function saveConfig(value) {
  const config = normalizeConfig(value);
  writeStore({ config });
  return config;
}

function createTrayImage() {
  if (fs.existsSync(iconPath)) {
    return nativeImage
      .createFromPath(iconPath)
      .resize({ width: 32, height: 32 });
  }

  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
          <circle cx="16" cy="16" r="13" fill="#0f2234" stroke="#62b1ff" stroke-width="2"/>
          <circle cx="16" cy="16" r="6" fill="#1fb689"/>
        </svg>`,
      ).toString("base64"),
  );
}

function getRendererUrl(page) {
  if (isDev) {
    return `${process.env.VITE_DEV_SERVER_URL}/${page}`;
  }
  return path.join(__dirname, "..", "dist", page);
}

async function loadWindow(window, page) {
  if (isDev) {
    await window.loadURL(getRendererUrl(page));
  } else {
    await window.loadFile(getRendererUrl(page));
  }
}

function emitMainWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("desktop:window-state", {
    isMaximized: mainWindow.isMaximized(),
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 840,
    minHeight: 700,
    show: false,
    frame: false,
    title: "Meeting Float",
    icon: iconPath,
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      session: rendererSession,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    emitMainWindowState();
  });

  mainWindow.on("maximize", emitMainWindowState);
  mainWindow.on("unmaximize", emitMainWindowState);
  mainWindow.on("restore", emitMainWindowState);

  let closeConfirmed = false;
  let closePromptOpen = false;
  mainWindow.on("close", async (event) => {
    if (isQuitting || closeConfirmed) return;
    event.preventDefault();
    if (closePromptOpen) return;

    const window = mainWindow;
    closePromptOpen = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: "关闭窗口",
        message: "关闭窗口还是最小化？",
        detail: "关闭窗口将停止当前录音；最小化后应用和录音会继续运行。",
        buttons: ["最小化窗口", "关闭窗口", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (isQuitting || window.isDestroyed()) return;
      if (response === 0) {
        window.minimize();
      } else if (response === 1) {
        closeConfirmed = true;
        window.close();
      }
    } catch (error) {
      console.error("Failed to show window close confirmation:", error);
    } finally {
      closePromptOpen = false;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadWindow(mainWindow, "index.html");
}

function createMinutesWindow(payload) {
  pendingMinutesPayload = payload;

  if (minutesWindow && !minutesWindow.isDestroyed()) {
    minutesWindow.focus();
    minutesWindow.webContents.send("minutes:payload", payload);
    return;
  }

  minutesWindow = new BrowserWindow({
    width: 760,
    height: 840,
    minWidth: 620,
    minHeight: 640,
    show: false,
    title: `${payload.title || "Meeting Minutes"} - Meeting Float`,
    icon: iconPath,
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      session: rendererSession,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  minutesWindow.once("ready-to-show", () => {
    minutesWindow.show();
    minutesWindow.webContents.send("minutes:payload", payload);
  });

  minutesWindow.on("closed", () => {
    minutesWindow = null;
    pendingMinutesPayload = null;
  });

  loadWindow(minutesWindow, "minutes.html");
}

function restoreMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip("Meeting Float");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Window", click: restoreMainWindow },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", restoreMainWindow);
}

function registerIpc() {
  ipcMain.handle("desktop:download-audio", ({ sender }, value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("录音下载地址必须使用 HTTP 或 HTTPS");
    }
    sender.downloadURL(url.href);
    return { ok: true };
  });
  ipcMain.handle("desktop:get-bootstrap", () => getBootstrapData());
  ipcMain.handle("desktop:save-config", (_, config) => saveConfig(config));
  ipcMain.handle("desktop:get-window-state", () => ({
    isMaximized: Boolean(mainWindow?.isMaximized()),
  }));
  ipcMain.handle("desktop:minimize-window", () => {
    mainWindow?.minimize();
    return { ok: true };
  });
  ipcMain.handle("desktop:toggle-maximize", () => {
    if (!mainWindow) {
      return { ok: false, isMaximized: false };
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    const state = { ok: true, isMaximized: mainWindow.isMaximized() };
    emitMainWindowState();
    return state;
  });
  ipcMain.handle("desktop:close-window", () => {
    mainWindow?.close();
    return { ok: true };
  });
  ipcMain.handle("desktop:minimize-to-tray", () => {
    mainWindow?.hide();
    return { ok: true };
  });
  ipcMain.handle("desktop:close-app", () => {
    app.quit();
    return { ok: true };
  });
  ipcMain.handle("desktop:open-minutes-window", (_, payload) => {
    createMinutesWindow(payload);
    return { ok: true };
  });
  ipcMain.handle("desktop:get-minutes-payload", () => pendingMinutesPayload);
}

app.whenReady().then(() => {
  rendererSession = session.fromPartition("meeting-memory", { cache: false });
  rendererSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(permission === "media");
  });

  registerIpc();
  createMainWindow();
  setupTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      restoreMainWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
