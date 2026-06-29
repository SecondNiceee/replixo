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
 * Когда окно прозрачное и стоит setIgnoreMouseEvents(true, { forward: true }),
 * ховерные события (onMouseEnter/onMouseLeave) на конкретных элементах НЕ
 * срабатывают надёжно, потому что окно игнорирует мышь. Зато события mousemove
 * пробрасываются в renderer (forward: true). Поэтому мы слушаем mousemove
 * глобально и на каждом движении проверяем, находится ли курсор над
 * интерактивным элементом (по атрибуту OVERLAY_INTERACTIVE_ATTR). Если да —
 * включаем перехват мыши (клики работают), если нет — снова пропускаем клики
 * на рабочий стол.
 */
export function useOverlayMouseManager(active: boolean) {
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (!active || !api) return

    let ignoring = true // стартуем в режиме "клики проходят сквозь"
    api.setIgnoreMouseEvents(true, { forward: true })

    // Координаты последнего движения и флаг запланированного кадра — чтобы
    // выполнять не более одного хит-теста на кадр (rAF-троттлинг), даже если
    // событий mousemove приходит десятки в секунду.
    let lastX = 0
    let lastY = 0
    let frame = 0

    const evaluate = () => {
      frame = 0
      const el = document.elementFromPoint(lastX, lastY)
      const overInteractive = !!el?.closest(`[${OVERLAY_INTERACTIVE_ATTR}]`)
      if (overInteractive && ignoring) {
        ignoring = false
        api.setIgnoreMouseEvents(false)
      } else if (!overInteractive && !ignoring) {
        ignoring = true
        api.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    const handleMove = (e: MouseEvent) => {
      lastX = e.clientX
      lastY = e.clientY
      if (!frame) frame = requestAnimationFrame(evaluate)
    }

    window.addEventListener("mousemove", handleMove)

    return () => {
      window.removeEventListener("mousemove", handleMove)
      if (frame) cancelAnimationFrame(frame)
      // Возвращаем нормальный перехват при выходе из overlay
      api.setIgnoreMouseEvents(false)
    }
  }, [active])
}
