// ---------------------------------------------------------------------------
// Диагностика крашей десктопного приложения.
//
// Проблема, которую решает этот модуль: приложение "просто закрывалось" во время
// демонстрации экрана, не оставляя после себя никаких следов. В Electron это
// почти всегда один из четырёх сценариев:
//
//   1. uncaughtException в main-процессе  -> Node печатает ошибку в stdout,
//      которого у упакованного .exe нет, и убивает процесс. Окно исчезает.
//   2. Краш renderer-процесса            -> событие "render-process-gone".
//   3. Краш GPU/utility-процесса         -> событие "child-process-gone".
//   4. Краш нативного кода (SEH)         -> minidump в crashDumps, событий нет.
//
// Модуль включает crashReporter (для minidump'ов), навешивает слушатели на все
// перечисленные события и дублирует ВСЁ в файл, чтобы после инцидента можно было
// прочитать лог, а не гадать.
//
// Файлы:
//   %APPDATA%/Replixo/logs/main.log      — текущий лог
//   %APPDATA%/Replixo/logs/main.prev.log — лог предыдущего запуска
//   %APPDATA%/Replixo/crashes/           — minidump'ы нативных крашей
// ---------------------------------------------------------------------------

const { app, crashReporter, dialog, shell, ipcMain } = require("electron")
const path = require("path")
const fs = require("fs")

const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 МБ, дальше ротация
const MAX_ARCHIVES = 5 // сколько датированных архивов храним

let logStream = null
let logDir = null
let logFilePath = null

const pad = (n, width = 2) => String(n).padStart(width, "0")

/**
 * Локальная дата и время в читаемом виде со смещением часового пояса:
 *   2026-07-29 14:03:12.345 +03:00
 *
 * Именно локальное время, а не UTC: пользователь сообщает "упало примерно в
 * три часа дня", и лог должен совпадать с его часами без пересчёта. Смещение
 * пишем явно, иначе логи из разных таймзон невозможно сопоставить.
 */
function timestamp(date = new Date()) {
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)} ${offset}`
  )
}

/** Компактная дата для имени файла: 2026-07-29_140312 */
function fileStamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function serialize(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack || "(no stack)"}`
  }
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Пишет строку и в консоль (для `pnpm electron`), и в файл (для прода). */
function write(level, scope, ...parts) {
  const line = `${timestamp()} [${level}] [${scope}] ${parts.map(serialize).join(" ")}`

  // eslint-disable-next-line no-console
  const sink = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log
  sink(line)

  try {
    logStream?.write(line + "\n")
  } catch {
    /* лог не должен ронять приложение */
  }
}

const log = {
  info: (scope, ...parts) => write("INFO", scope, ...parts),
  warn: (scope, ...parts) => write("WARN", scope, ...parts),
  error: (scope, ...parts) => write("ERROR", scope, ...parts),
}

function openLogFile() {
  logDir = path.join(app.getPath("userData"), "logs")
  fs.mkdirSync(logDir, { recursive: true })
  logFilePath = path.join(logDir, "main.log")

  // Ротация: архив получает дату в имени, поэтому по файлам сразу видно, к
  // какому дню относится краш, и старый архив не затирается новым.
  try {
    if (fs.existsSync(logFilePath)) {
      const stat = fs.statSync(logFilePath)
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(logFilePath, path.join(logDir, `main.${fileStamp(stat.mtime)}.log`))
      }
    }
    pruneOldLogs()
  } catch {
    /* ignore */
  }

  logStream = fs.createWriteStream(logFilePath, { flags: "a" })
  logStream.on("error", () => {
    logStream = null
  })

  // Разделитель между запусками: в append-режиме без него непонятно, где
  // закончилась прошлая сессия (та, что упала) и началась новая.
  const now = new Date()
  try {
    logStream.write(
      `\n=== session start ${timestamp(now)} (${now.toISOString()} UTC) ===\n`,
    )
  } catch {
    /* ignore */
  }
}

/** Держим не больше MAX_ARCHIVES датированных архивов, удаляя самые старые. */
function pruneOldLogs() {
  const archives = fs
    .readdirSync(logDir)
    .filter((name) => /^main\..+\.log$/.test(name))
    .sort()

  for (const name of archives.slice(0, Math.max(0, archives.length - MAX_ARCHIVES))) {
    try {
      fs.unlinkSync(path.join(logDir, name))
    } catch {
      /* ignore */
    }
  }
}

/**
 * Вызывать ПЕРВОЙ строкой в main.js, до app.whenReady(): crashReporter должен
 * быть запущен раньше, чем создаётся любой дочерний процесс, иначе их краши не
 * попадут в дампы.
 */
function initDiagnostics() {
  openLogFile()

  const crashDir = path.join(app.getPath("userData"), "crashes")
  try {
    fs.mkdirSync(crashDir, { recursive: true })
    app.setPath("crashDumps", crashDir)
  } catch {
    /* ignore */
  }

  // uploadToServer: false — дампы остаются локально, ничего не уходит наружу.
  crashReporter.start({ uploadToServer: false, compress: true })

  log.info("startup", {
    startedAt: timestamp(),
    startedAtUtc: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    osRelease: require("os").release(),
    arch: process.arch,
    logFile: logFilePath,
    crashDumps: crashDir,
  })

  // -------------------------------------------------------------------------
  // Сценарий 1: необработанная ошибка в main-процессе.
  // Именно это выглядит как "приложение просто закрылось": Node печатает stack
  // в отсутствующий stdout и завершает процесс с кодом 1.
  // -------------------------------------------------------------------------
  process.on("uncaughtException", (error) => {
    log.error("uncaughtException", error)
    // Не даём процессу умереть молча: приложение остаётся жить, а пользователь
    // видит, что произошло, и может прислать лог.
    try {
      dialog.showErrorBox(
        "Replixo: внутренняя ошибка",
        `${error?.message || error}\n\nПодробности записаны в:\n${logFilePath}`,
      )
    } catch {
      /* ignore */
    }
  })

  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", reason)
  })

  // -------------------------------------------------------------------------
  // Сценарии 2 и 3: краши renderer / GPU / utility процессов.
  // -------------------------------------------------------------------------
  app.on("render-process-gone", (_event, _webContents, details) => {
    log.error("render-process-gone", details)
  })

  app.on("child-process-gone", (_event, details) => {
    log.error("child-process-gone", details)
  })

  app.on("gpu-process-crashed", (_event, killed) => {
    log.error("gpu-process-crashed", { killed })
  })

  app.on("quit", (_event, exitCode) => {
    log.info("quit", { exitCode, uptimeSec: Math.round(process.uptime()) })
  })

  app.on("before-quit", () => log.info("before-quit"))

  // Сценарий 4: если прошлый запуск оставил minidump — сообщаем об этом в лог.
  try {
    const reports = crashReporter.getUploadedReports?.() || []
    if (reports.length) log.warn("previous-crash-reports", { count: reports.length })
  } catch {
    /* ignore */
  }
}

/** Слушатели, которые можно навесить только после создания окна. */
function attachWindowDiagnostics(win) {
  if (!win) return

  win.webContents.on("render-process-gone", (_e, details) => {
    log.error("window:render-process-gone", details)
  })

  win.webContents.on("unresponsive", () => log.warn("window:unresponsive"))
  win.webContents.on("responsive", () => log.info("window:responsive"))

  win.webContents.on("did-fail-load", (_e, code, description, url) => {
    log.error("window:did-fail-load", { code, description, url })
  })

  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    log.error("window:preload-error", { preloadPath }, error)
  })

  // Ошибки из renderer тоже попадают в файл — иначе после краша окна
  // DevTools-консоль недоступна.
  win.webContents.on("console-message", (event) => {
    if (event.level !== "error" && event.level !== "warning") return
    log[event.level === "error" ? "error" : "warn"]("renderer", event.message, `(${event.lineNumber})`)
  })
}

/** IPC для кнопки "открыть папку логов" в интерфейсе поддержки. */
function setupDiagnosticsIpc() {
  ipcMain.handle("open-logs-folder", () => {
    if (!logDir) return false
    shell.openPath(logDir)
    return true
  })

  ipcMain.handle("get-log-path", () => logFilePath)
}

module.exports = { initDiagnostics, attachWindowDiagnostics, setupDiagnosticsIpc, log }
