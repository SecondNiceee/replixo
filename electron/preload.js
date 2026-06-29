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
  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
  // Переход в прозрачный overlay-режим (демонстрация экрана)
  enterOverlayMode: () => ipcRenderer.send("enter-overlay-mode"),
  // Выход из overlay-режима (восстановление нормального окна)
  exitOverlayMode: () => ipcRenderer.send("exit-overlay-mode"),
})
