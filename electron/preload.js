const { contextBridge, ipcRenderer } = require("electron")

// Безопасный мостик между web-приложением и Electron.
contextBridge.exposeInMainWorld("replixoDesktop", {
  isDesktop: true,
  platform: process.platform,
})

// Electron API — getDesktopSources для захвата экрана + overlay-режим.
// Renderer проверяет window.electronAPI?.isElectron и использует
// нативный путь вместо navigator.mediaDevices.getDisplayMedia().
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
  // Переход в прозрачный overlay-режим (демонстрация экрана)
  enterOverlayMode: () => ipcRenderer.send("enter-overlay-mode"),
  // Выход из overlay-режима (восстановление нормального окна)
  exitOverlayMode: () => ipcRenderer.send("exit-overlay-mode"),

  // Управление безрамочным окном (кастомный титлбар)
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.send("window-maximize-toggle"),
  windowClose: () => ipcRenderer.send("window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizeChange: (callback) => {
    const handler = (_e, isMaximized) => callback(isMaximized)
    ipcRenderer.on("window-maximize-changed", handler)
    // Возвращаем функцию отписки
    return () => ipcRenderer.removeListener("window-maximize-changed", handler)
  },

  // Click-through в overlay-режиме: ignore=true — клики проходят сквозь окно.
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send("set-ignore-mouse-events", ignore, options),

  // Позиция курсора относительно окна (для надёжного hit-test в overlay-режиме,
  // не зависящего от ненадёжных forwarded mousemove на прозрачном окне).
  getCursorPoint: () => ipcRenderer.invoke("get-cursor-point"),
})
