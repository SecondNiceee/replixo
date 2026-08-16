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
  // Передаёт выбранный в кастомном пикере источник в main до вызова
  // штатного navigator.mediaDevices.getDisplayMedia().
  setDisplaySource: (sourceId) => ipcRenderer.invoke("set-display-source", sourceId),
  // Слежение за окном показа слайдов PowerPoint: показ открывается отдельным
  // окном, поэтому захват окна редактора надо молча переключать на него.
  startPresentationWatch: (payload) => ipcRenderer.invoke("start-presentation-watch", payload),
  stopPresentationWatch: () => ipcRenderer.invoke("stop-presentation-watch"),
  onPresentationSourceChanged: (callback) => {
    const handler = (_e, info) => callback(info)
    ipcRenderer.on("presentation-source-changed", handler)
    return () => ipcRenderer.removeListener("presentation-source-changed", handler)
  },

  // Прямоугольник демонстрируемого источника в координатах содержимого overlay-окна.
  // Нужен, чтобы канвас рисования совпадал с картинкой у зрителей, когда
  // демонстрируется окно, занимающее лишь часть экрана.
  getCaptureRegion: () => ipcRenderer.invoke("get-capture-region"),
  onCaptureRegionChanged: (callback) => {
    const handler = (_e, region) => callback(region)
    ipcRenderer.on("capture-region-changed", handler)
    return () => ipcRenderer.removeListener("capture-region-changed", handler)
  },

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

  // Глобальный двойной клик приходит из native mouse hook даже тогда, когда
  // прозрачное overlay-окно пропускает события в приложение под ним.
  onGlobalDoubleClick: (callback) => {
    const handler = (_e, point) => callback(point)
    ipcRenderer.on("global-double-click", handler)
    return () => ipcRenderer.removeListener("global-double-click", handler)
  },

  // Нативная запись в буфер обмена ОС (надёжнее, чем navigator.clipboard в
  // безрамочном/прозрачном окне Electron).
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard-write-text", text),

  // -------------------------------------------------------------------------
  // Variant A: нативный захват системного звука через WASAPI process-loopback
  // c исключением дерева процессов Electron (см. about/echo-fix/plan.md).
  // Renderer превращает поток PCM в MediaStreamTrack для демонстрации экрана.
  // -------------------------------------------------------------------------
  // Поддерживается ли нативный захват (Windows >= 19041 и есть бинарь helper'а).
  getAudioCaptureSupport: () => ipcRenderer.invoke("get-audio-capture-support"),
  // Запустить helper. Возвращает { supported, sampleRate, channels } или причину.
  startAudioCapture: () => ipcRenderer.invoke("start-audio-capture"),
  // Остановить helper.
  stopAudioCapture: () => ipcRenderer.invoke("stop-audio-capture"),
  // Подписка на кадры PCM (Uint8Array с float32 LE) с номером пакета.
  // Возвращает функцию отписки.
  onAudioCaptureData: (callback) => {
    const handler = (_e, chunk, seq) => callback(chunk, seq)
    ipcRenderer.on("audio-capture-data", handler)
    return () => ipcRenderer.removeListener("audio-capture-data", handler)
  },
  // Подтверждение приёма пакета. Без него main перестаёт слать звук и держит его
  // в своей ограниченной очереди, вместо того чтобы копить в очереди Chromium IPC.
  ackAudioCaptureData: (seq) => ipcRenderer.send("audio-capture-ack", seq),
  // Уведомление о завершении процесса захвата. Возвращает функцию отписки.
  onAudioCaptureEnded: (callback) => {
    const handler = (_e, code) => callback(code)
    ipcRenderer.on("audio-capture-ended", handler)
    return () => ipcRenderer.removeListener("audio-capture-ended", handler)
  },

  // -------------------------------------------------------------------------
  // Диагностика: путь к логу и открытие папки логов в проводнике, чтобы
  // пользователь мог прислать файл после вылета.
  // -------------------------------------------------------------------------
  getLogPath: () => ipcRenderer.invoke("get-log-path"),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),
})
