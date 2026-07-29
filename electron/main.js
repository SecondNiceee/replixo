const { app, BrowserWindow, shell, session, ipcMain, desktopCapturer, clipboard } = require("electron")
const path = require("path")
const fs = require("fs")
const os = require("os")
const { spawn } = require("child_process")
const {
  initDiagnostics,
  attachWindowDiagnostics,
  setupDiagnosticsIpc,
  log,
} = require("./diagnostics")

// Диагностика включается ДО app.whenReady() и до создания дочерних процессов,
// иначе их краши не попадут в minidump'ы.
initDiagnostics()

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

  attachWindowDiagnostics(mainWindow)

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

  // Перезагрузка страницы (F5, потеря соединения, навигация) уничтожает
  // AudioWorklet в renderer, но нативный хелпер и IPC-помпа продолжали жить и
  // качать PCM в никуда — утечка процесса и лишняя нагрузка при каждом reload.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      stopAudioCapture()
      stopGlobalMouseHook()
    }
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
// Глобальный двойной клик для click-through overlay.
// DOM не получает dblclick, когда окно пропускает мышь на рабочий стол, поэтому
// во время демонстрации используем нативный hook и передаём жест в renderer.
// ---------------------------------------------------------------------------
let globalMouseHook = null
let globalMouseDownHandler = null
let lastPrimaryClick = null

const DOUBLE_CLICK_MS = 500
const DOUBLE_CLICK_DISTANCE = 6

function stopGlobalMouseHook() {
  if (!globalMouseHook) return
  if (globalMouseDownHandler) {
    globalMouseHook.removeListener("mousedown", globalMouseDownHandler)
  }
  try {
    globalMouseHook.stop()
  } catch {
    // Hook уже мог остановиться при завершении ОС-сессии.
  }
  globalMouseHook = null
  globalMouseDownHandler = null
  lastPrimaryClick = null
}

function startGlobalMouseHook() {
  stopGlobalMouseHook()

  try {
    const { uIOhook } = require("uiohook-napi")
    globalMouseHook = uIOhook
    globalMouseDownHandler = (event) => {
      // uiohook: 1 — основная кнопка мыши.
      if (event.button !== 1 || !mainWindow || mainWindow.isDestroyed() || !overlayRestoreState) return

      const current = { x: event.x, y: event.y, time: Date.now() }
      const isDoubleClick = lastPrimaryClick
        && current.time - lastPrimaryClick.time <= DOUBLE_CLICK_MS
        && Math.abs(current.x - lastPrimaryClick.x) <= DOUBLE_CLICK_DISTANCE
        && Math.abs(current.y - lastPrimaryClick.y) <= DOUBLE_CLICK_DISTANCE

      lastPrimaryClick = isDoubleClick ? null : current
      if (!isDoubleClick) return

      // Electron screen API и DOM используют DIP-координаты. Координаты native
      // hook могут быть физическими пикселями при Windows scaling, поэтому для
      // renderer берём актуальную позицию курсора через Electron.
      const { screen } = require("electron")
      const cursor = screen.getCursorScreenPoint()
      const bounds = mainWindow.getContentBounds()
      const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
      if (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height) return

      mainWindow.webContents.send("global-double-click", point)
    }
    globalMouseHook.on("mousedown", globalMouseDownHandler)
    globalMouseHook.start()
  } catch (error) {
    stopGlobalMouseHook()
    log.error("global-mouse-hook", "failed to start", error)
  }
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
    startGlobalMouseHook()
  })

  ipcMain.on("exit-overlay-mode", () => {
    stopGlobalMouseHook()
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

// ---------------------------------------------------------------------------
// Variant A (about/echo-fix/plan.md): native WASAPI process-loopback capture.
//
// A standalone helper (electron/native/process-loopback) captures the whole
// system audio mix MINUS Electron's process tree — the OS-level equivalent of
// restrictOwnAudio. It streams raw float32/48k/stereo PCM on stdout; we forward
// it to the renderer, which turns it into a MediaStreamTrack for screen share.
//
// If the OS is older than Windows 10 build 19041, or the helper binary is not
// bundled, we report `supported: false` and the renderer falls back to the
// previous loopback + AEC path (no regression).
// ---------------------------------------------------------------------------
let audioCaptureProc = null
let audioCaptureTimer = null
let audioCaptureQueue = Buffer.alloc(0)
let lastOverflowLogAt = 0

const AUDIO_FRAME_BYTES = 2 * Float32Array.BYTES_PER_ELEMENT
const AUDIO_IPC_FRAMES = 960 // 20 ms at 48 kHz
const AUDIO_IPC_BYTES = AUDIO_IPC_FRAMES * AUDIO_FRAME_BYTES
const AUDIO_IPC_INTERVAL_MS = 20
const AUDIO_MAX_QUEUE_BYTES = 48000 * AUDIO_FRAME_BYTES / 2 // 500 ms

function clearAudioCaptureBuffer() {
  if (audioCaptureTimer) {
    clearInterval(audioCaptureTimer)
    audioCaptureTimer = null
  }
  audioCaptureQueue = Buffer.alloc(0)
}

function startAudioCapturePump() {
  clearAudioCaptureBuffer()
  audioCaptureTimer = setInterval(() => {
    if (audioCaptureQueue.length < AUDIO_IPC_BYTES) return

    const packet = audioCaptureQueue.subarray(0, AUDIO_IPC_BYTES)
    audioCaptureQueue = audioCaptureQueue.subarray(AUDIO_IPC_BYTES)
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Copy because packet references the queue's previous backing allocation.
      mainWindow.webContents.send("audio-capture-data", Buffer.from(packet))
    }
  }, AUDIO_IPC_INTERVAL_MS)
}

// Locate the bundled helper .exe (dev vs packaged).
function resolveLoopbackHelperPath() {
  const candidates = [
    // Packaged: shipped via electron-builder extraResources.
    path.join(process.resourcesPath || "", "native", "process-loopback-capture.exe"),
    // Dev: built into the source tree.
    path.join(__dirname, "native", "process-loopback", "bin", "process-loopback-capture.exe"),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

// Windows build number from os.release() (e.g. "10.0.19045" -> 19045).
function windowsBuildNumber() {
  const m = /^\d+\.\d+\.(\d+)/.exec(os.release() || "")
  return m ? Number.parseInt(m[1], 10) : 0
}

function getAudioCaptureSupport() {
  if (process.platform !== "win32") {
    return { supported: false, reason: "not-windows" }
  }
  if (windowsBuildNumber() < 19041) {
    return { supported: false, reason: "old-windows" }
  }
  if (!resolveLoopbackHelperPath()) {
    return { supported: false, reason: "helper-missing" }
  }
  return { supported: true, sampleRate: 48000, channels: 2 }
}

function stopAudioCapture() {
  clearAudioCaptureBuffer()
  if (audioCaptureProc) {
    const proc = audioCaptureProc
    audioCaptureProc = null
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
}

function setupAudioCapture() {
  ipcMain.handle("get-audio-capture-support", () => getAudioCaptureSupport())

  ipcMain.handle("start-audio-capture", () => {
    const support = getAudioCaptureSupport()
    if (!support.supported) return support

    // Exclude the whole Electron process tree (main PID). The renderer runs as
    // a child of main, so EXCLUDE_TARGET_PROCESS_TREE strips our call audio.
    const helper = resolveLoopbackHelperPath()
    stopAudioCapture()

    try {
      audioCaptureProc = spawn(helper, [String(process.pid)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      log.error("loopback", "spawn threw", err)
      return { supported: false, reason: "spawn-failed", error: String(err) }
    }

    // КРИТИЧНО: spawn() НЕ бросает исключение синхронно, если .exe не удалось
    // запустить (антивирус, файл занят, повреждённая установка) — он асинхронно
    // эмитит событие "error". Без слушателя это превращается в
    // uncaughtException и МГНОВЕННО убивает main-процесс: приложение просто
    // исчезает без единого сообщения. То же самое с EPIPE на stdout/stderr,
    // когда хелпер умирает в момент записи PCM.
    //
    // Это и была причина вылетов при "демонстрации со звуком": единственный
    // сценарий, в котором приложение вообще спавнит дочерний процесс.
    audioCaptureProc.on("error", (err) => {
      log.error("loopback", "helper process error", err)
      stopAudioCapture()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("audio-capture-ended", -1)
      }
    })
    audioCaptureProc.stdout.on("error", (err) => log.error("loopback", "stdout error", err))
    audioCaptureProc.stderr.on("error", (err) => log.error("loopback", "stderr error", err))

    startAudioCapturePump()

    audioCaptureProc.stdout.on("data", (chunk) => {
      audioCaptureQueue = Buffer.concat([audioCaptureQueue, chunk])

      // Keep latency bounded under renderer stalls. Always drop complete stereo
      // frames from the oldest audio rather than replaying stale YouTube audio.
      if (audioCaptureQueue.length > AUDIO_MAX_QUEUE_BYTES) {
        const excess = audioCaptureQueue.length - AUDIO_MAX_QUEUE_BYTES
        const alignedDrop = Math.ceil(excess / AUDIO_FRAME_BYTES) * AUDIO_FRAME_BYTES
        audioCaptureQueue = audioCaptureQueue.subarray(alignedDrop)
        // Троттлим лог: при затыке renderer'а это событие срабатывает десятки раз
        // в секунду, и сам логгер становится источником нагрузки.
        const now = Date.now()
        if (now - lastOverflowLogAt > 1000) {
          lastOverflowLogAt = now
          log.warn("loopback", "PCM queue overflow; dropped oldest audio", { droppedBytes: alignedDrop })
        }
      }
    })

    audioCaptureProc.stderr.on("data", (buf) => {
      const text = String(buf).trim()
      if (text) log.info("loopback", text)
    })

    const captureProc = audioCaptureProc
    captureProc.on("exit", (code, signal) => {
      log.info("loopback", "helper exited", { code, signal })
      // Ignore the stale exit event if another helper has already replaced it.
      if (audioCaptureProc !== captureProc) return
      audioCaptureProc = null
      clearAudioCaptureBuffer()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("audio-capture-ended", code)
      }
    })

    return { supported: true, sampleRate: support.sampleRate, channels: support.channels }
  })

  ipcMain.handle("stop-audio-capture", () => {
    stopAudioCapture()
    return true
  })
}

app.whenReady().then(() => {
  setupMediaPermissions()
  setupDesktopCapturer()
  setupWindowControls()
  setupOverlayMode()
  setupClipboard()
  setupAudioCapture()
  setupDiagnosticsIpc()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("before-quit", () => {
  stopGlobalMouseHook()
  stopAudioCapture()
})

app.on("window-all-closed", () => {
  stopGlobalMouseHook()
  stopAudioCapture()
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
