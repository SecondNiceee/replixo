"use client"

import { useEffect } from "react"

/**
 * Атрибут-маркер для интерактивных областей overlay-режима. Любой элемент с
 * этим атрибутом (или его потомок) будет «ловить» клики; всё остальное окно
 * пропускает клики на рабочий стол.
 */
export const OVERLAY_INTERACTIVE_ATTR = "data-overlay-interactive"

/**
 * Навешивается на корневой интерактивный контейнер overlay-области
 * (панель контролов, сайдбар участников). Возвращает props с маркером.
 */
export function useOverlayClickThrough() {
  return { [OVERLAY_INTERACTIVE_ATTR]: "true" } as const
}

/**
 * Глобальный менеджер click-through для overlay-режима в Electron.
 *
 * ПРОБЛЕМА: когда окно прозрачное и стоит setIgnoreMouseEvents(true), на Windows
 * forwarded-события mousemove ({ forward: true }) доходят до renderer НЕнадёжно —
 * особенно над полностью прозрачными пикселями (где виден рабочий стол). Из-за
 * этого hit-test не срабатывает, перехват мыши никогда не включается, и все клики
 * (по нижним контролам и по сайдбару участников) уходят сквозь окно на рабочий стол.
 *
 * РЕШЕНИЕ: не полагаемся на DOM-события мыши вообще. Вместо этого на каждом кадре
 * опрашиваем РЕАЛЬНУЮ позицию курсора из ОС через main-процесс
 * (electronAPI.getCursorPoint → screen.getCursorScreenPoint) и сами делаем
 * hit-test через document.elementFromPoint. Если курсор над элементом с атрибутом
 * OVERLAY_INTERACTIVE_ATTR — включаем перехват мыши (клики работают), иначе —
 * пропускаем клики на рабочий стол. Это детерминированно и не зависит от
 * прозрачности окна.
 */
export function useOverlayMouseManager(active: boolean) {
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (!active || !api || typeof api.getCursorPoint !== "function") return

    let ignoring = true // стартуем в режиме "клики проходят сквозь"
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    api.setIgnoreMouseEvents(true, { forward: true })

    const tick = async () => {
      if (stopped) return
      try {
        const pt = await api.getCursorPoint!()
        if (pt && !stopped) {
          const el = document.elementFromPoint(pt.x, pt.y)
          const overInteractive = !!el?.closest(`[${OVERLAY_INTERACTIVE_ATTR}]`)
          if (overInteractive && ignoring) {
            ignoring = false
            // forward:false здесь не нужен — окно полностью перехватывает мышь.
            api.setIgnoreMouseEvents(false)
          } else if (!overInteractive && !ignoring) {
            ignoring = true
            api.setIgnoreMouseEvents(true, { forward: true })
          }
        }
      } catch {
        // ignore — продолжаем опрос
      }
      // ~30 опросов/сек: отзывчиво, но без лишней нагрузки на IPC.
      if (!stopped) timer = setTimeout(tick, 32)
    }

    tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      // Возвращаем нормальный перехват при выходе из overlay
      api.setIgnoreMouseEvents(false)
    }
  }, [active])
}
