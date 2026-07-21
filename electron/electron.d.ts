// Type declarations for Electron IPC bridge injected via preload.js

interface DesktopSource {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
}

interface ElectronAPI {
  isElectron: true
  platform: string
  getDesktopSources: () => Promise<DesktopSource[]>
  // Передаёт выбранный источник в main для setDisplayMediaRequestHandler
  setDisplaySource: (sourceId: string) => Promise<boolean>
  // Overlay-режим (демонстрация экрана)
  enterOverlayMode: () => void
  exitOverlayMode: () => void
  // Управление безрамочным окном (кастомный титлбар)
  windowMinimize: () => void
  windowMaximizeToggle: () => void
  windowClose: () => void
  isWindowMaximized: () => Promise<boolean>
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
  // Click-through в overlay-режиме
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => void
  // Позиция курсора относительно окна (надёжный hit-test для click-through)
  getCursorPoint: () => Promise<{ x: number; y: number } | null>
  // Глобальный двойной клик в координатах содержимого overlay-окна
  onGlobalDoubleClick: (callback: (point: { x: number; y: number }) => void) => () => void
  // Нативная запись в буфер обмена ОС
  writeClipboardText: (text: string) => Promise<boolean>

  // Variant A — нативный захват системного звука (WASAPI process-loopback),
  // исключающий дерево процессов Electron. См. about/echo-fix/plan.md.
  getAudioCaptureSupport: () => Promise<AudioCaptureSupport>
  startAudioCapture: () => Promise<AudioCaptureSupport>
  stopAudioCapture: () => Promise<boolean>
  onAudioCaptureData: (callback: (chunk: Uint8Array) => void) => () => void
  onAudioCaptureEnded: (callback: (code: number | null) => void) => () => void
}

interface AudioCaptureSupport {
  supported: boolean
  reason?: string
  error?: string
  sampleRate?: number
  channels?: number
}

interface ReplixoDesktop {
  isDesktop: boolean
  platform: string
}

declare interface Window {
  electronAPI?: ElectronAPI
  replixoDesktop?: ReplixoDesktop
}

declare interface MediaDevices {
  __electronPatched?: boolean
}
