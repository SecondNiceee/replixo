// ---------------------------------------------------------------------------
// Автообновление десктоп-приложения (electron-updater, generic-провайдер).
//
// Как это работает:
// 1. `pnpm dist` кладёт в release/ установщик, его .blockmap и latest.yml.
// 2. Эти три файла заливаются на VPS в папку UPDATES_DIR сервера; сервер отдаёт
//    её по https://replixo.ru/updates/ (см. server/src/index.ts).
// 3. Приложение читает /updates/latest.yml, сравнивает версию с app.getVersion()
//    (поле version в package.json) и в фоне скачивает новую сборку. Благодаря
//    .blockmap качается только изменившаяся часть установщика, а не весь файл.
// 4. Скачанное обновление ставится при выходе из приложения либо сразу, если
//    пользователь нажал «Перезапустить» в уведомлении. Звонок посреди урока
//    принудительно не прерывается.
// ---------------------------------------------------------------------------
const { app, ipcMain } = require("electron")
const { log } = require("./diagnostics")

const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let state = { status: "idle", version: null, percent: null, error: null }
let getWindow = () => null

function publish(next) {
  state = { ...state, ...next }
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send("update-status", state)
  }
}

function setupAutoUpdater(windowGetter) {
  getWindow = windowGetter

  ipcMain.handle("get-app-version", () => app.getVersion())
  ipcMain.handle("get-update-status", () => state)

  // В dev-режиме (`electron .`) latest.yml нет и app-update.yml не создаётся —
  // electron-updater только сыпал бы ошибками в лог.
  if (!app.isPackaged) {
    ipcMain.handle("check-for-updates", () => state)
    ipcMain.handle("install-update", () => false)
    return
  }

  const { autoUpdater } = require("electron-updater")
  autoUpdater.logger = {
    info: (m) => log.info("updater", String(m)),
    warn: (m) => log.warn("updater", String(m)),
    error: (m) => log.error("updater", String(m)),
    debug: () => {},
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("checking-for-update", () => publish({ status: "checking", error: null }))
  autoUpdater.on("update-available", (info) =>
    publish({ status: "downloading", version: info.version, percent: 0 }),
  )
  autoUpdater.on("update-not-available", () => publish({ status: "idle", percent: null }))
  autoUpdater.on("download-progress", (p) =>
    publish({ status: "downloading", percent: Math.round(p.percent) }),
  )
  autoUpdater.on("update-downloaded", (info) =>
    publish({ status: "ready", version: info.version, percent: 100 }),
  )
  autoUpdater.on("error", (error) => {
    // Нет сети / сервер обновлений недоступен — не повод беспокоить пользователя,
    // следующая проверка будет через CHECK_INTERVAL_MS.
    publish({ status: state.status === "ready" ? "ready" : "idle", error: error?.message || String(error) })
  })

  const check = () => {
    if (state.status === "downloading" || state.status === "ready") return
    autoUpdater.checkForUpdates().catch((error) => {
      log.warn("updater", "check failed", error?.message || error)
    })
  }

  ipcMain.handle("check-for-updates", () => {
    check()
    return state
  })
  ipcMain.handle("install-update", () => {
    if (state.status !== "ready") return false
    log.info("updater", "quitAndInstall", { version: state.version })
    // isSilent=true — без окна мастера NSIS; isForceRunAfter=true — запустить
    // приложение заново после установки.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return true
  })

  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS)
}

module.exports = { setupAutoUpdater }
