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
  // Нативная запись в буфер обмена ОС
  writeClipboardText: (text: string) => Promise<boolean>
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
