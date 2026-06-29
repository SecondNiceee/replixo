const { contextBridge, ipcRenderer } = require("electron")

// Безопасный мостик между web-приложением и Electron.
contextBridge.exposeInMainWorld("replixoDesktop", {
  isDesktop: true,
  platform: process.platform,
})

// Electron API — getDesktopSources для захвата экрана.
// Renderer проверяет window.electronAPI?.isElectron и использует
// нативный путь вместо navigator.mediaDevices.getDisplayMedia().
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getDesktopSources: () => ipcRenderer.invoke("get-desktop-sources"),
})
