const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  screen,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const config = require("./config");
const { transcribe } = require("./transcription");

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Unhandled error safety net
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow = null;
let settingsWindow = null;
let historyWindow = null;
let setupWindow = null;
let tray = null;

// ---------------------------------------------------------------------------
// Transcription History
// ---------------------------------------------------------------------------
const MAX_HISTORY_ENTRIES = 50;
let historyEntries = [];
let historyFilePath = null;

function initHistory(userDataPath) {
  historyFilePath = path.join(userDataPath, "history.json");
  loadHistoryFromDisk();
}

function loadHistoryFromDisk() {
  if (!historyFilePath) return;
  try {
    if (fs.existsSync(historyFilePath)) {
      const raw = fs.readFileSync(historyFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        historyEntries = parsed.slice(-MAX_HISTORY_ENTRIES);
      }
    }
  } catch (err) {
    console.error("Failed to load history from disk:", err.message);
    historyEntries = [];
  }
}

function saveHistoryToDisk() {
  if (!historyFilePath) return;
  try {
    const dir = path.dirname(historyFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      historyFilePath,
      JSON.stringify(historyEntries, null, 2),
      "utf-8"
    );
  } catch (err) {
    console.error("Failed to save history to disk:", err.message);
  }
}

function addHistoryEntry(entry) {
  historyEntries.push(entry);
  if (historyEntries.length > MAX_HISTORY_ENTRIES) {
    historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
  }
  saveHistoryToDisk();

  // Notify the history window if it is open
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send("history-new-entry", entry);
  }
}

const preloadPath = path.join(__dirname, "preload.js");

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } =
    primaryDisplay.workAreaSize;

  const winWidth = 300;
  const winHeight = 80;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round((screenWidth - winWidth) / 2),
    y: screenHeight - winHeight - 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile("renderer.html");

  // Make transparent areas click-through while keeping opaque areas interactive
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Setup / registration window (first run)
// ---------------------------------------------------------------------------
function openSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    title: "Welcome - Yiddish Voice",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  setupWindow.setMenu(null);
  setupWindow.loadFile("setup.html");

  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------
function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 400,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Settings - Yiddish Voice",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadFile("settings.html");

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ---------------------------------------------------------------------------
// History window
// ---------------------------------------------------------------------------
function openHistoryWindow() {
  if (historyWindow) {
    historyWindow.focus();
    return;
  }

  historyWindow = new BrowserWindow({
    width: 520,
    height: 600,
    minWidth: 380,
    minHeight: 400,
    resizable: true,
    minimizable: true,
    maximizable: true,
    title: "Transcription History - Yiddish Voice",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  historyWindow.setMenu(null);
  historyWindow.loadFile("history.html");

  historyWindow.on("closed", () => {
    historyWindow = null;
  });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png"));

  tray = new Tray(icon);
  tray.setToolTip("Yiddish Voice");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show / Hide",
      click: () => {
        if (!mainWindow) return;
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      },
    },
    { type: "separator" },
    {
      label: "History",
      click: () => openHistoryWindow(),
    },
    {
      label: "Settings",
      click: () => openSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------
function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' mediastream:;",
        ],
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Global hotkey
// ---------------------------------------------------------------------------
function registerGlobalShortcut() {
  globalShortcut.unregisterAll();
  const hotkey = config.get("hotkey") || "Ctrl+Shift+Space";
  const registered = globalShortcut.register(hotkey, () => {
    if (!mainWindow) return;
    // Send toggle - let the renderer decide based on its own state
    mainWindow.webContents.send("toggle-recording");
  });

  if (!registered) {
    console.error(`Failed to register global shortcut ${hotkey}`);
  }
}

// ---------------------------------------------------------------------------
// Paste helper — uses Win32 SendInput via PowerShell for reliability
// ---------------------------------------------------------------------------
function pasteTextAtCursor(text) {
  return new Promise((resolve, reject) => {
    clipboard.writeText(text);

    // Simple Ctrl+V simulation. Works because overlay has focusable:false
    // so the target app always retains focus.
    exec(
      `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
      { timeout: 5000 },
      (error) => {
        if (error) {
          console.error("Paste simulation failed:", error.message);
          return reject(error);
        }
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function setupIpcHandlers() {
  // -- Recording toggle from renderer ----------------------------------------
  ipcMain.on("start-recording", () => {});
  ipcMain.on("stop-recording", () => {});

  // -- Transcription ---------------------------------------------------------
  ipcMain.on("transcribe", async (event, { audioBase64, provider }) => {
    try {
      const cfg = config.load();
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const result = await transcribe(audioBuffer, provider, cfg);

      if (event.sender.isDestroyed()) return;

      if (result.error) {
        console.error("Transcription failed:", result.error);
        event.sender.send("transcription-result", { error: result.error });
        return;
      }

      // Auto-paste if configured
      if (cfg.autoPlace && result.text) {
        try {
          await pasteTextAtCursor(result.text);
        } catch (pasteErr) {
          console.error("Auto-paste failed:", pasteErr.message);
        }
      }

      // Save to transcription history
      if (result.text) {
        addHistoryEntry({
          id:
            Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8),
          timestamp: new Date().toISOString(),
          text: result.text,
          provider: result.provider,
          latencyMs: result.latencyMs,
        });
      }

      if (event.sender.isDestroyed()) return;
      event.sender.send("transcription-result", {
        text: result.text,
        provider: result.provider,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      console.error("Transcription error:", err);
      if (!event.sender.isDestroyed()) {
        event.sender.send("transcription-result", { error: err.message });
      }
    }
  });

  // -- Paste text manually ---------------------------------------------------
  ipcMain.handle("paste-text", async (_event, text) => {
    try {
      await pasteTextAtCursor(text);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // -- Config IPC for settings window ----------------------------------------
  ipcMain.handle("get-config", () => {
    return config.load();
  });

  ipcMain.handle("save-config", (_event, newConfig) => {
    const oldHotkey = config.get("hotkey");
    config.save(newConfig);
    // Re-register hotkey if it changed
    if (newConfig.hotkey !== oldHotkey) {
      registerGlobalShortcut();
    }
    return { success: true };
  });

  // -- Open settings from renderer ------------------------------------------
  ipcMain.on("open-settings", () => {
    openSettingsWindow();
  });

  // -- Complete first-run setup ----------------------------------------------
  ipcMain.handle("complete-setup", (_event, { email }) => {
    const cfg = config.load();
    cfg.userEmail = email || '';
    cfg.setupComplete = true;
    config.save(cfg);
    return { success: true };
  });

  // -- Window mouse-event forwarding -----------------------------------------
  ipcMain.on("set-ignore-mouse", (_event, ignore) => {
    if (!mainWindow) return;
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  // -- History IPC handlers --------------------------------------------------
  ipcMain.handle("history-get", () => {
    return historyEntries;
  });

  ipcMain.handle("history-clear", () => {
    historyEntries = [];
    saveHistoryToDisk();
    return { success: true };
  });

  ipcMain.handle("history-delete", (_event, id) => {
    historyEntries = historyEntries.filter((entry) => entry.id !== id);
    saveHistoryToDisk();
    return { success: true };
  });

  // -- Clipboard (used by history window click-to-copy) ----------------------
  ipcMain.handle("copy-to-clipboard", (_event, text) => {
    clipboard.writeText(text);
    return { success: true };
  });

  // -- File picker -----------------------------------------------------------
  ipcMain.handle("select-file", async () => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "JSON Files", extensions: ["json"] }],
      title: "Select Service Account JSON",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  const userDataPath = app.getPath("userData");
  config.init(userDataPath);
  config.load(); // ensure defaults exist
  initHistory(userDataPath);

  setupCSP();
  createOverlayWindow();
  createTray();
  registerGlobalShortcut();
  setupIpcHandlers();

  // Show registration screen on first launch
  const cfg = config.load();
  if (!cfg.setupComplete) {
    openSetupWindow();
  }
});

// Focus existing window when second instance is launched
app.on("second-instance", () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Keep running in tray on Windows
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createOverlayWindow();
  }
});
