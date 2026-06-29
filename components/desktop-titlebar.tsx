"use client"

import { useEffect, useState } from "react"
import { Minus, Square, Copy, X } from "lucide-react"

/**
 * Кастомная титульная панель для Electron.
 *
 * Так как окно создаётся безрамочным (frame: false) ради прозрачности в
 * overlay-режиме, нативные кнопки свернуть/развернуть/закрыть отсутствуют —
 * их заменяет этот компонент. Полоса перетаскивания задаётся через CSS-свойство
 * `-webkit-app-region: drag`, а кнопки — `no-drag`.
 *
 * Рендерится только в Electron. В overlay-режиме скрывается через CSS
 * (см. globals.css: html[data-overlay="1"] .desktop-titlebar).
 */
export function DesktopTitlebar() {
  const [isElectron, setIsElectron] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.isElectron) return
    setIsElectron(true)

    window.electronAPI.isWindowMaximized().then(setIsMaximized).catch(() => {})
    const unsubscribe = window.electronAPI.onMaximizeChange(setIsMaximized)
    return unsubscribe
  }, [])

  if (!isElectron) return null

  return (
    <div
      className="desktop-titlebar fixed inset-x-0 top-0 z-[10000] flex h-8 items-center justify-between border-b border-border/60 bg-background/95 backdrop-blur-sm"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Заголовок + зона перетаскивания */}
      <span className="select-none pl-3 text-xs font-medium tracking-wide text-muted-foreground">
        Replixo
      </span>

      {/* Кнопки управления окном */}
      <div
        className="flex h-full items-stretch"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={() => window.electronAPI?.windowMinimize()}
          aria-label="Свернуть"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Minus className="size-4" />
        </button>
        <button
          onClick={() => window.electronAPI?.windowMaximizeToggle()}
          aria-label={isMaximized ? "Восстановить" : "Развернуть"}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {isMaximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </button>
        <button
          onClick={() => window.electronAPI?.windowClose()}
          aria-label="Закрыть"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
