const { app } = require("electron")
const { log } = require("./diagnostics")

function setupUpdates() {
  if (!app.isPackaged || process.platform !== "win32") return

  const { autoUpdater } = require("electron-updater")
  autoUpdater.logger = {
    info: (message) => log.info("updates", message),
    warn: (message) => log.warn("updates", message),
    error: (message) => log.error("updates", message),
  }
  autoUpdater.autoDownload = true
  // Install on normal exit so an update never interrupts a call.
  autoUpdater.autoInstallOnAppQuit = true

  const check = () => {
    // electron-updater logs errors itself. Keep temporary network failures
    // from turning into unhandled rejections in the main process.
    void autoUpdater.checkForUpdates().catch(() => {})
  }
  setTimeout(check, 10_000).unref()
  setInterval(check, 4 * 60 * 60 * 1000).unref()
}

module.exports = { setupUpdates }
