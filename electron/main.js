const { app, BrowserWindow, shell, session, ipcMain, desktopCapturer, clipboard } = require("electron")
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
    // Прозрачность на Windows возможна только при frame: false и transparent: true,
    // причём оба параметра задаются ТОЛЬКО при создании окна (их нельзя
    // переключить позже). Поэтому окно всегда безрамочное + прозрачное, а
    // нативную рамку заменяет кастомный титлбар (DesktopTitlebar) в renderer.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
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
// Источник, выбранный пользователем в кастомном пикере (renderer), который
// setDisplayMediaRequestHandler должен вернуть Chromium при следующем вызове
// navigator.mediaDevices.getDisplayMedia().
let pendingDisplaySourceId = null

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

  // Renderer сообщает, какой источник выбрал пользователь в нашем оверлей-пикере,
  // ПЕРЕД тем как вызвать штатный getDisplayMedia().
  ipcMain.handle("set-display-source", (_e, sourceId) => {
    pendingDisplaySourceId = sourceId
    return true
  })

  // ---------------------------------------------------------------------------
  // Нативный обработчик демонстрации экрана.
  //
  // Раньше renderer подменял getDisplayMedia() на legacy-getUserMedia c
  // chromeMediaSource:"desktop". Этот старый путь захватывает системный звук
  // целиком (loopback) и ПОЛНОСТЬЮ игнорирует constraints — в частности
  // restrictOwnAudio. Из-за этого при "демонстрации со звуком" в аудиодорожку
  // попадал звук самого звонка (голоса других участников, которые проигрываются
  // на машине демонстрирующего), возвращался обратно, и зритель слышал самого
  // себя с задержкой (эхо).
  //
  // Здесь мы используем штатный путь: renderer вызывает настоящий
  // navigator.mediaDevices.getDisplayMedia(constraints), Chromium (в Electron 42
  // это Chromium 148, где restrictOwnAudio уже поддержан) применяет
  // restrictOwnAudio к аудиодорожке, а мы лишь подставляем выбранный источник и
  // включаем системный loopback только если звук действительно запрошен.
  // ---------------------------------------------------------------------------
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] })
        const chosen = sources.find((s) => s.id === pendingDisplaySourceId) || sources[0]
        pendingDisplaySourceId = null
        if (!chosen) {
          callback({})
          return
        }
        // audio:"loopback" — системный звук; собственный звук вкладки исключает
        // restrictOwnAudio (constraint из renderer), поэтому эха больше нет.
        callback({ video: chosen, audio: request.audioRequested ? "loopback" : undefined })
      } catch {
        callback({})
      }
    },
    // Используем наш кастомный пикер, а не системный
    { useSystemPicker: false },
  )
}

// ---------------------------------------------------------------------------
// Управление безрамочным окном из renderer (кастомный титлбар).
// Так как frame: false убирает нативные кнопки, их заменяет DesktopTitlebar,
// который шлёт эти IPC-команды.
// ---------------------------------------------------------------------------
function setupWindowControls() {
  ipcMain.on("window-minimize", () => mainWindow?.minimize())

  ipcMain.on("window-maximize-toggle", () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })

  ipcMain.on("window-close", () => mainWindow?.close())

  ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false)

  // Уведомляем renderer об изменении состояния развёрнутости (для иконки кнопки)
  const notifyMaximizeState = () => {
    if (!mainWindow) return
    mainWindow.webContents.send("window-maximize-changed", mainWindow.isMaximized())
  }
  // Навешиваем слушатели после создания окна
  app.whenReady().then(() => {
    if (!mainWindow) return
    mainWindow.on("maximize", notifyMaximizeState)
    mainWindow.on("unmaximize", notifyMaximizeState)
  })

  // Click-through: в overlay-режиме окно по умолчанию пропускает клики на рабочий
  // стол, а renderer включает перехват только когда курсор над интерактивным UI.
  ipcMain.on("set-ignore-mouse-events", (_e, ignore, options) => {
    if (!mainWindow) return
    mainWindow.setIgnoreMouseEvents(!!ignore, options || undefined)
  })

  // Глобальная позиция курсора относительно содержимого окна.
  //
  // В overlay-режиме окно прозрачное и стоит setIgnoreMouseEvents(true), поэтому
  // forwarded-события mousemove на Windows доходят до renderer НЕнадёжно (особенно
  // над полностью прозрачными пикселями). Чтобы click-through работал детерминированно,
  // renderer опрашивает реальную позицию курсора из ОС через этот хэндлер и сам
  // делает hit-test (elementFromPoint). screen.getCursorScreenPoint() и
  // getContentBounds() возвращают DIP-координаты — те же, что использует CSS/DOM.
  ipcMain.handle("get-cursor-point", () => {
    if (!mainWindow) return null
    const { screen } = require("electron")
    const cursor = screen.getCursorScreenPoint()
    const bounds = mainWindow.getContentBounds()
    return { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
  })
}

// ---------------------------------------------------------------------------
// Overlay-режим: окно растягивается на весь экран поверх всего и пропускает
// клики на рабочий стол. Само приложение прячется (renderer делает фон
// прозрачным), остаётся только сайдбар участников слева и плавающие контролы.
// ---------------------------------------------------------------------------
let overlayRestoreState = null

function setupOverlayMode() {
  ipcMain.on("enter-overlay-mode", () => {
    if (!mainWindow) return

    // Сохраняем прежнее состояние для восстановления
    overlayRestoreState = {
      bounds: mainWindow.getBounds(),
      isMaximized: mainWindow.isMaximized(),
      alwaysOnTop: mainWindow.isAlwaysOnTop(),
    }

    const { screen } = require("electron")
    const display = screen.getDisplayMatching(mainWindow.getBounds())
    const { x, y, width, height } = display.bounds

    // Снимаем maximize, иначе setBounds может игнорироваться
    if (mainWindow.isMaximized()) mainWindow.unmaximize()

    mainWindow.setAlwaysOnTop(true, "screen-saver")
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setBounds({ x, y, width, height })
    // По умолчанию пропускаем клики сквозь окно (на рабочий стол под ним).
    // forward: true — события мыши всё равно доходят до renderer, чтобы
    // сработал hover на контролах и мы временно вернули перехват.
    mainWindow.setIgnoreMouseEvents(true, { forward: true })
  })

  ipcMain.on("exit-overlay-mode", () => {
    if (!mainWindow || !overlayRestoreState) return

    mainWindow.setIgnoreMouseEvents(false)
    mainWindow.setAlwaysOnTop(overlayRestoreState.alwaysOnTop)
    mainWindow.setVisibleOnAllWorkspaces(false)
    mainWindow.setBounds(overlayRestoreState.bounds)

    if (overlayRestoreState.isMaximized) {
      mainWindow.maximize()
    }

    overlayRestoreState = null
  })
}

// ---------------------------------------------------------------------------
// Буфер обмена. navigator.clipboard.writeText в Electron ненадёжен (требует
// secure context + фокус окна, а наше окно безрамочное/прозрачное), поэтому
// renderer использует нативный clipboard через этот IPC как основной путь.
// ---------------------------------------------------------------------------
function setupClipboard() {
  ipcMain.handle("clipboard-write-text", (_e, text) => {
    clipboard.writeText(String(text ?? ""))
    return true
  })
}

app.whenReady().then(() => {
  setupMediaPermissions()
  setupDesktopCapturer()
  setupWindowControls()
  setupOverlayMode()
  setupClipboard()
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
