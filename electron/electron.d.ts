// Type declarations for Electron IPC bridge injected via preload.js

interface DesktopSource {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
}

interface ElectronAPI {
  isElectron: true
  getDesktopSources: () => Promise<DesktopSource[]>
}

interface ReplixoDesktop {
  isDesktop: boolean
  platform: string
}

declare interface Window {
  electronAPI?: ElectronAPI
  replixoDesktop?: ReplixoDesktop
}
