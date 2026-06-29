const { contextBridge } = require("electron")

// Безопасный мостик между web-приложением и Electron.
// Сейчас приложение работает как обычный сайт, поэтому достаточно
// сообщить ему, что оно запущено внутри десктоп-оболочки.
contextBridge.exposeInMainWorld("replixoDesktop", {
  isDesktop: true,
  platform: process.platform,
})
