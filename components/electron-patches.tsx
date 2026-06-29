"use client"

import { useEffect } from "react"

/**
 * Активирует патчи специфичные для Electron-окружения.
 * В браузере — ничего не делает (window.electronAPI отсутствует).
 * Монтируется один раз в корневом layout.
 */
export function ElectronPatches() {
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!window.electronAPI?.isElectron) return

    // Динамический импорт — чтобы не тащить код в браузерный бандл
    import("../electron/patches/screen-share.js").then(({ patchElectronDisplayMedia }) => {
      patchElectronDisplayMedia()
    })
  }, [])

  return null
}
