const { app, BrowserWindow, shell, session, ipcMain, desktopCapturer } = require("electron")
const path = require("path")

// URL задеплоенного приложения. Можно переопределить переменной окружения APP_URL.
const APP_URL = process.env.APP_URL || "https://replixo.ru"

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    show: false,
    autoHideMenuBar: true,
    title: "Replixo",
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow.show()
  })

  mainWindow.loadURL(APP_URL)

  // Внешние ссылки (mailto, другие домены) открываем в системном браузере
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) {
      return { action: "allow" }
    }
    shell.openExternal(url)
    return { action: "deny" }
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// Разрешения медиа (камера, микрофон, захват экрана)
// ---------------------------------------------------------------------------
function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ["media", "display-capture", "mediaKeySystem", "notifications", "clipboard-read"]
    callback(allowed.includes(permission))
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ["media", "display-capture", "mediaKeySystem", "notifications", "clipboard-read"]
    return allowed.includes(permission)
  })
}

// ---------------------------------------------------------------------------
// desktopCapturer — IPC-обработчик для демонстрации экрана.
//
// В Electron navigator.mediaDevices.getDisplayMedia() не показывает picker
// операционной системы сам по себе: браузер внутри Electron не имеет доступа к
// нативному API захвата рабочего стола. Вместо этого нужно:
//   1. Получить список источников (окна / весь экран) из главного процесса через
//      desktopCapturer.getSources() — это нативный Node/Electron API.
//   2. Вернуть источники в renderer, показать там свой picker (или взять первый).
//   3. Передать выбранный sourceId в getUserMedia с параметром chromeMediaSource.
//
// Preload пробрасывает вызов через contextBridge → renderer использует
// window.electronAPI.getDesktopSources() вместо getDisplayMedia напрямую.
// ---------------------------------------------------------------------------
function setupDesktopCapturer() {
  ipcMain.handle("get-desktop-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })

    // Возвращаем только сериализуемые данные (thumbnail — DataURL)
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    }))
  })
}

app.whenReady().then(() => {
  setupMediaPermissions()
  setupDesktopCapturer()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// Один экземпляр приложения
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
