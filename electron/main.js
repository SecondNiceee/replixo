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

// Имя приложения задаём ДО initDiagnostics(): app.getPath("userData") строится
// из app.getName(), а тот берётся из package.json ("productName" || "name").
// Без этого userData был %APPDATA%\my-project, и папки %APPDATA%\Replixo,
// описанной в диагностике, на машине пользователя просто не существовало.
app.setName("Replixo")

// ---------------------------------------------------------------------------
// Явный лимит heap + снапшот у предела — чтобы отличать OOM от нативного краша.
//
// Без --max-old-space-size V8 берёт лимит из объёма ОЗУ машины, поэтому «упало
// по памяти» выглядит по-разному у разных пользователей, а в логах остаётся
// только необъяснимое исчезновение процесса — ровно как при нативном краше.
// С фиксированным лимитом и снапшотом у предела OOM однозначно опознаётся:
// либо в логах есть предупреждение heap-monitor и .heapsnapshot, либо это
// нативный краш и надо смотреть minidump.
//
// Switch влияет на renderer и дочерние V8-изолаты; собственный heap main-процесса
// отслеживает heap-monitor в diagnostics.js.
// ---------------------------------------------------------------------------
const JS_HEAP_LIMIT_MB = Number(process.env.REPLIXO_MAX_OLD_SPACE_MB) || 1024
app.commandLine.appendSwitch(
  "js-flags",
  `--max-old-space-size=${JS_HEAP_LIMIT_MB} --heap-snapshot-near-heap-limit=1`,
)

// Диагностика включается ДО app.whenReady() и до создания дочерних процессов,
// иначе их краши не попадут в minidump'ы.
initDiagnostics()

// URL задеплоенного приложения. Можно переопределить переменной окружения APP_URL.
const APP_URL = process.env.APP_URL || "https://replixo.ru"

let mainWindow = null

// ---------------------------------------------------------------------------
// Загрузка APP_URL с повторными попытками.
//
// Зачем: загрузка главного фрейма может провалиться по причинам, никак не
// связанным с самим приложением — сеть ещё не поднялась после логина в Windows,
// VPN переключается, или сервер оборвал streaming-ответ Next.js на середине
// (ERR_INCOMPLETE_CHUNKED_ENCODING / ERR_EMPTY_RESPONSE). Браузер такой обрыв
// прощает и рисует частичный HTML, а Chromium внутри Electron считает
// навигацию проваленной и показывает свою заглушку
// "This page couldn't load — A server error occurred", из которой пользователь
// выйти не может: кнопки Reload там нет, F5 на chrome-error:// не работает.
//
// Поэтому: перехватываем did-fail-load, автоматически повторяем загрузку с
// нарастающей задержкой, и только если попытки закончились — показываем СВОЙ
// экран с понятным текстом, кодом ошибки и рабочей кнопкой «Повторить».
// ---------------------------------------------------------------------------
const LOAD_RETRY_DELAYS_MS = [500, 1500, 3000, 5000]
let loadAttempt = 0

// -3 (ERR_ABORTED) — не ошибка: так выглядит навигация, отменённая новой
// навигацией или редиректом. Повторять её нельзя, иначе получим цикл.
const IGNORED_LOAD_ERRORS = new Set([-3])

function renderLoadErrorPage(code, description) {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body {
    margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0a0a; color: #fafafa; -webkit-app-region: drag;
    font: 400 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 26rem; padding: 2rem; text-align: center; -webkit-app-region: no-drag }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; font-weight: 600 }
  p { margin: 0 0 1.5rem; color: #a1a1a1 }
  code { font-family: ui-monospace, monospace; font-size: .8125rem; color: #737373 }
  button {
    font: inherit; font-weight: 500; cursor: pointer; padding: .625rem 1.25rem;
    border: 0; border-radius: .625rem; background: #fafafa; color: #0a0a0a;
  }
  button:hover { opacity: .9 }
  /* Окно безрамочное (frame: false), а кастомный титлбар живёт в renderer
     основного приложения — на этой странице его нет. Без своей кнопки закрытия
     пользователь остался бы в окне, которое нечем закрыть. */
  #close {
    position: fixed; top: 0; right: 0; width: 46px; height: 34px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: transparent; color: #a1a1a1; border-radius: 0; font-size: 15px;
    -webkit-app-region: no-drag;
  }
  #close:hover { background: #e81123; color: #fff; opacity: 1 }
</style></head>
<body>
  <button id="close" onclick="window.close()" aria-label="Закрыть" title="Закрыть">&#10005;</button>
  <main>
  <h1>Не удалось подключиться к Replixo</h1>
  <p>Сервер не ответил или оборвал соединение. Проверьте интернет и попробуйте снова.</p>
  <button onclick="location.replace(${JSON.stringify(APP_URL)})">Повторить</button>
  <p style="margin:1.5rem 0 0"><code>${code} ${String(description || "").replace(/</g, "&lt;")}</code></p>
</main></body></html>`

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function loadAppUrl() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(APP_URL).catch((error) => {
    // loadURL реджектится тем же кодом, что придёт в did-fail-load, поэтому
    // саму повторную попытку планирует обработчик события — зде��ь только лог.
    log.warn("load", "loadURL rejected", error?.message || error)
  })
}

function setupLoadRetry(win) {
  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || IGNORED_LOAD_ERRORS.has(code)) return
    // Ошибки загрузки нашей же data:-заглушки повторять бессмысленно.
    if (url && url.startsWith("data:")) return

    const delay = LOAD_RETRY_DELAYS_MS[loadAttempt]
    if (delay === undefined) {
      log.error("load", "giving up after retries", { code, description, url })
      renderLoadErrorPage(code, description)
      return
    }

    loadAttempt += 1
    log.warn("load", "retrying", { attempt: loadAttempt, delay, code, description })
    setTimeout(loadAppUrl, delay)
  })

  // Успешная загрузка сбрасывает счётчик: следующий сбой снова получит все
  // попытки, иначе после одного обрыва за сессию приложение теряло защиту.
  win.webContents.on("did-finish-load", () => {
    loadAttempt = 0
  })
}

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

  // Страховка: ready-to-show ждёт первую отрисовку, а если сервер не отвечает,
  // отрисовки может не быть вовсе — окно никогда не покажется, и приложение
  // выглядит как «запустилось и ничего не произошло». Через 10 секунд
  // показываем окно принудительно, чтобы пользователь увидел хотя бы экран
  // ошибки с кнопкой «Повторить».
  const forceShowTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log.warn("load", "forcing window show: no first paint within 10s")
      mainWindow.show()
    }
  }, 10_000)

  setupLoadRetry(mainWindow)
  loadAppUrl()

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
    clearTimeout(forceShowTimer)
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
        const requestedId = pendingDisplaySourceId
        // Если источник запрошен явно, но исчез (окно успело закрыться) — отказ.
        // Молчаливый fallback на sources[0] означал бы, что вместо окна показа
        // слайдов в трансляцию внезапно уходит весь рабочий стол.
        const chosen = requestedId ? sources.find((s) => s.id === requestedId) : sources[0]
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
// Слежение за окном слайд-шоу PowerPoint.
//
// Мы захватываем КОНКРЕТНОЕ окно (HWND), а PowerPoint открывает показ слайдов
// в ОТДЕЛЬНОМ полноэкранном окне. Поэтому зритель продолжал видеть окно
// редактора, хотя докладчик уже запустил показ. Zoom решает это тем же
// способом: следит за окнами приложения-источника и молча переключает захват
// на окно показа, а после выхода из показа возвращается к редактору.
//
// Определяем окно по заголовку: у показа слайдов он локализованный
// («Показ слайдов PowerPoint — [Презентация1]» / «PowerPoint Slide Show»).
// Окно «Режим докладчика» (Presenter View) исключаем: показ слайдов для
// зрителей — это другое окно, и переключаться надо именно на него.
// ---------------------------------------------------------------------------
// Приложение-презентация в заголовке выбранного окна. Кроме PowerPoint сюда
// попадают Impress и Keynote — у них показ слайдов тоже отдельное окно.
const PRESENTATION_APP_WINDOW_RE = /powerpoint|impress|keynote|\.pptx?(\s|$|\])|\.odp(\s|$|\])|\.key(\s|$|\])/i
// Заголовок окна показа слайдов. У PowerPoint он локализованный
// («Показ слайдов PowerPoint — [Презентация1]» / «PowerPoint Slide Show»),
// у Impress — «Презентация» / «Presentation».
const SLIDESHOW_WINDOW_RE = /powerpoint\s+slide\s+show|показ\s+слайдов|слайд-шоу|slide\s*show|impress\s+presentation/i
// Окно «Режим докладчика» (Presenter View) исключаем: зрителям надо отдавать
// именно окно показа, а не заметки докладчика.
const PRESENTER_VIEW_WINDOW_RE = /presenter\s+view|presenter\s+console|режим\s+докладчика|консоль\s+докладчика/i

// Опрашиваем список окон: событий «появилось окно другого приложения» в
// Electron нет, а WGC-захват стартует только по идентификатору окна.
const PRESENTATION_POLL_MS = 900

let presentationWatch = null

function isSlideshowWindow(name) {
  return SLIDESHOW_WINDOW_RE.test(name) && !PRESENTER_VIEW_WINDOW_RE.test(name)
}

// Имя документа из заголовка окна: «Отчёт.pptx - PowerPoint» → «отчёт»,
// «Показ слайдов PowerPoint - [Отчёт]» → «отчёт». Нужно, чтобы не переключиться
// на показ ДРУГОЙ презентации, открытой в том же PowerPoint параллельно.
function presentationDocumentKey(name) {
  const bracketed = name.match(/\[([^\]]+)\]/)
  const raw = bracketed
    ? bracketed[1]
    : name.split(/\s+[-–—]\s+/).find((part) => !/^\s*(powerpoint|impress|keynote)\s*$/i.test(part)) || name
  return raw
    .replace(/\.(pptx?|odp|key)\s*$/i, "")
    .replace(/\s*[-–—]\s*(powerpoint|impress|keynote).*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function stopPresentationWatch() {
  if (!presentationWatch) return false
  clearInterval(presentationWatch.timer)
  presentationWatch = null
  return true
}

async function pollPresentationWindows() {
  const watch = presentationWatch
  if (!watch || watch.busy) return
  watch.busy = true
  try {
    // thumbnailSize 0x0 — список окон нужен только ради заголовков, кадры не
    // рендерим, иначе опрос раз в секунду сам бы жёг CPU во время показа.
    const windows = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    })
    if (presentationWatch !== watch) return

    const slideshowWindows = windows.filter((w) => isSlideshowWindow(w.name))
    // Сначала показ ИМЕННО той презентации, которую демонстрируют. Если совпадения
    // по документу нет (заголовок показа может не содержать имени файла — например
    // «Показ слайдов PowerPoint»), берём единственный найденный показ.
    const slideshow =
      slideshowWindows.find((w) => presentationDocumentKey(w.name) === watch.documentKey)
      || (slideshowWindows.length === 1 ? slideshowWindows[0] : null)

    if (slideshow && slideshow.id !== watch.activeId) {
      watch.activeId = slideshow.id
      mainWindow?.webContents.send("presentation-source-changed", {
        sourceId: slideshow.id,
        name: slideshow.name,
        kind: "slideshow",
      })
      return
    }

    // Показ закрыли (вышли из режима демонстрации) — возвращаемся к окну,
    // которое пользователь выбрал изначально, не прерывая демонстрацию.
    if (!slideshow && watch.activeId !== watch.originId) {
      const origin = windows.find((w) => w.id === watch.originId)
      if (!origin) return
      watch.activeId = watch.originId
      mainWindow?.webContents.send("presentation-source-changed", {
        sourceId: origin.id,
        name: origin.name,
        kind: "origin",
      })
    }
  } catch {
    /* окно могло закрыться между опросами — следующий тик разберётся */
  } finally {
    watch.busy = false
  }
}

function setupPresentationWatch() {
  ipcMain.handle("start-presentation-watch", (_e, payload) => {
    const sourceId = payload?.sourceId
    const sourceName = String(payload?.sourceName ?? "")
    stopPresentationWatch()

    // Следим только за захватом ОКНА приложения-презентации. Для захвата всего
    // экрана переключаться не нужно: показ слайдов и так попадёт в кадр.
    if (typeof sourceId !== "string" || !sourceId.startsWith("window:")) return false
    if (!PRESENTATION_APP_WINDOW_RE.test(sourceName) && !SLIDESHOW_WINDOW_RE.test(sourceName)) return false

    presentationWatch = {
      originId: sourceId,
      activeId: sourceId,
      documentKey: presentationDocumentKey(sourceName),
      busy: false,
      timer: setInterval(pollPresentationWindows, PRESENTATION_POLL_MS),
    }
    return true
  })

  ipcMain.handle("stop-presentation-watch", () => stopPresentationWatch())
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
let lastOverflowLogAt = 0

const AUDIO_FRAME_BYTES = 2 * Float32Array.BYTES_PER_ELEMENT
const AUDIO_IPC_FRAMES = 960 // 20 ms at 48 kHz
const AUDIO_IPC_BYTES = AUDIO_IPC_FRAMES * AUDIO_FRAME_BYTES
const AUDIO_IPC_INTERVAL_MS = 20
const AUDIO_BYTES_PER_SEC = 48000 * AUDIO_FRAME_BYTES // 384 КБ/с

// Очередь в main держит 2 с вместо 500 мс. Причина: буфер в main — это ОДИН
// массив чанков с известным размером, который мы контролируем; просадка
// renderer'а или таймера на 300-800 мс (энкодер + GPU под демонстрацией) при
// лимите 500 мс приводила к выбросу живого звука и щелчкам. 2 с дают запас на
// такие просадки, при этом это всего ~768 КБ — на порядок дешевле, чем прежняя
// неограниченная очередь внутри Chromium IPC.
const AUDIO_QUEUE_MS = 2000
const AUDIO_MAX_QUEUE_BYTES = (AUDIO_BYTES_PER_SEC * AUDIO_QUEUE_MS) / 1000

// Сколько пакетов насос отдаёт за один тик, догоняя отставание. Не зависит от
// размера очереди: 25 пакетов = 500 мс звука — этого хватает, чтобы выбраться из
// любой реальной просадки таймера, и это не превращает один тик в лавину IPC.
const AUDIO_MAX_PACKETS_PER_TICK = 25

// ---------------------------------------------------------------------------
// Backpressure на IPC.
//
// КРИТИЧНО: webContents.send() — это fire-and-forget. Если renderer занят
// (GC, перерисовка, энкодер), пакеты не исчезают — они копятся в НЕОГРАНИЧЕННОЙ
// внутренней очереди Chromium IPC, о которой мы ничего не знаем и которую не
// можем ни измерить, ни обрезать. Наша аккуратно ограниченная очередь в main при
// этом выглядит пустой, а память растёт в чужом буфере, пока процесс не умрёт.
//
// Поэтому renderer подтверждает приём каждого пакета (audio-capture-ack с его
// номером), а main перестаёт слать, пока неподтверждённых больше
// AUDIO_MAX_IN_FLIGHT_PACKETS. Звук в это время остаётся в НАШЕЙ очереди, где
// его при переполнении можно осознанно подрезать с начала.
//
// AUDIO_ACK_TIMEOUT_MS — предохранитель: если renderer вообще не отвечает
// (старый preload без ack, ack потерялся при перезагрузке страницы), окно
// открывается заново, иначе звук замолчал бы навсегда.
// ---------------------------------------------------------------------------
const AUDIO_MAX_IN_FLIGHT_PACKETS = 10 // 200 мс неподтверждённого звука
const AUDIO_ACK_TIMEOUT_MS = 1000

let audioSentSeq = 0
let audioAckedSeq = 0
let lastAudioAckAt = 0
let lastBackpressureLogAt = 0

// ---------------------------------------------------------------------------
// PCM queue as a list of chunks instead of one contiguous Buffer.
//
// КРИТИЧНО: раньше здесь был `Buffer.concat([queue, chunk])` на каждый чанк
// stdout. При 48 кГц/стерео/float32 это ~384 КБ/с, и каждый чанк вызывал новую
// аллокацию плюс копирование ВСЕЙ очереди (до 500 КБ) — десятки раз в секунду.
// Это фрагментировало heap main-процесса и держало GC под постоянной нагрузкой,
// пока Windows не убивала audio/video-процессы (exitCode 0x40010004).
//
// Чанки теперь только добавляются в массив, а байты копируются один раз — при
// сборке исходящего IPC-пакета фиксированного размера.
// ---------------------------------------------------------------------------
let audioChunks = []
let audioQueuedBytes = 0

function audioQueuePush(chunk) {
  audioChunks.push(chunk)
  audioQueuedBytes += chunk.length
}

function audioQueueReset() {
  audioChunks = []
  audioQueuedBytes = 0
}

// Drop the oldest `bytes` without touching the rest of the queue.
function audioQueueDropFront(bytes) {
  let remaining = bytes
  while (remaining > 0 && audioChunks.length > 0) {
    const head = audioChunks[0]
    if (head.length <= remaining) {
      remaining -= head.length
      audioQueuedBytes -= head.length
      audioChunks.shift()
    } else {
      audioChunks[0] = head.subarray(remaining)
      audioQueuedBytes -= remaining
      remaining = 0
    }
  }
}

// Pull exactly `bytes` off the front, or null when there is not enough audio.
function audioQueueTake(bytes) {
  if (audioQueuedBytes < bytes) return null

  // Fast path: the head chunk already holds exactly one packet, so hand the
  // buffer over as-is with zero copying.
  if (audioChunks[0].length === bytes) {
    audioQueuedBytes -= bytes
    return audioChunks.shift()
  }

  const out = Buffer.allocUnsafe(bytes)
  let offset = 0
  while (offset < bytes) {
    const head = audioChunks[0]
    const need = bytes - offset
    if (head.length <= need) {
      head.copy(out, offset)
      offset += head.length
      audioChunks.shift()
    } else {
      head.copy(out, offset, 0, need)
      audioChunks[0] = head.subarray(need)
      offset += need
    }
  }
  audioQueuedBytes -= bytes
  return out
}

function clearAudioCaptureBuffer() {
  if (audioCaptureTimer) {
    clearInterval(audioCaptureTimer)
    audioCaptureTimer = null
  }
  audioQueueReset()
}

function audioResetFlowControl() {
  audioSentSeq = 0
  audioAckedSeq = 0
  lastAudioAckAt = Date.now()
}

function startAudioCapturePump() {
  clearAudioCaptureBuffer()
  audioResetFlowControl()
  audioCaptureTimer = setInterval(() => {
    // No consumer: drop audio instead of letting the queue grow behind a
    // destroyed window.
    if (!mainWindow || mainWindow.isDestroyed()) {
      audioQueueReset()
      return
    }

    // КРИТИЧНО: отдаём ВСЁ накопленное, а не один пакет за тик. Таймеры Electron
    // под нагрузкой (демонстрация экрана грузит GPU и энкодер) плывут до 30-50 мс,
    // поэтому один пакет 20 мс за тик физически не успевает за хелпером. Отставание
    // копилось до переполнения очереди на каждом чанке — в логах это 96 466 строк
    // "PCM queue overflow" из 96 534. Теперь насос догоняет после каждой просадки.
    let sent = 0
    while (audioQueuedBytes >= AUDIO_IPC_BYTES && sent < AUDIO_MAX_PACKETS_PER_TICK) {
      const inFlight = audioSentSeq - audioAckedSeq

      if (inFlight >= AUDIO_MAX_IN_FLIGHT_PACKETS) {
        const silentFor = Date.now() - lastAudioAckAt

        // Renderer молчит слишком долго — считаем подтверждения потерянными и
        // открываем окно заново, иначе звук больше никогда не поедет.
        if (silentFor > AUDIO_ACK_TIMEOUT_MS) {
          log.warn("loopback", "ack timeout; reopening IPC window", { inFlight, silentFor })
          audioResetFlowControl()
          continue
        }

        const now = Date.now()
        if (now - lastBackpressureLogAt > 1000) {
          lastBackpressureLogAt = now
          log.warn("loopback", "IPC backpressure; holding PCM in main queue", {
            inFlight,
            queuedMs: Math.round((audioQueuedBytes / AUDIO_BYTES_PER_SEC) * 1000),
          })
        }
        break
      }

      const packet = audioQueueTake(AUDIO_IPC_BYTES)
      if (!packet) break
      audioSentSeq++
      mainWindow.webContents.send("audio-capture-data", packet, audioSentSeq)
      sent++
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

  // Подтверждение приёма от renderer'а. Номера монотонные, поэтому достаточно
  // хранить максимальный: пропущенный ack «догоняется» следующим.
  ipcMain.on("audio-capture-ack", (_e, seq) => {
    const acked = Number(seq)
    if (!Number.isFinite(acked)) return
    if (acked > audioAckedSeq) audioAckedSeq = Math.min(acked, audioSentSeq)
    lastAudioAckAt = Date.now()
  })

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
      audioQueuePush(chunk)

      // Keep latency bounded under renderer stalls. Always drop complete stereo
      // frames from the oldest audio rather than replaying stale YouTube audio.
      if (audioQueuedBytes > AUDIO_MAX_QUEUE_BYTES) {
        const excess = audioQueuedBytes - AUDIO_MAX_QUEUE_BYTES
        const alignedDrop = Math.ceil(excess / AUDIO_FRAME_BYTES) * AUDIO_FRAME_BYTES
        audioQueueDropFront(alignedDrop)
        // Троттлим лог: при затыке renderer'а это событие срабатывает десятки раз
        // в секунду, и сам логгер становится источником нагрузки.
        const now = Date.now()
        if (now - lastOverflowLogAt > 1000) {
          lastOverflowLogAt = now
          log.warn("loopback", "PCM queue overflow; dropped oldest audio", {
            droppedBytes: alignedDrop,
            queueMs: AUDIO_QUEUE_MS,
            inFlight: audioSentSeq - audioAckedSeq,
          })
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
  setupPresentationWatch()
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
  stopPresentationWatch()
})

app.on("window-all-closed", () => {
  stopGlobalMouseHook()
  stopAudioCapture()
  stopPresentationWatch()
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
