"use client"

import { useCallback } from "react"

/**
 * В overlay-режиме окно Electron по умолчанию пропускает клики на рабочий стол
 * (setIgnoreMouseEvents(true, { forward: true })). Чтобы интерактивные элементы
 * (панель контролов, сайдбар участников) реагировали на мышь, мы временно
 * включаем перехват, когда курсор над элементом, и выключаем при уходе.
 *
 * Возвращает обработчики, которые нужно навесить на корневой интерактивный
 * контейнер overlay-области.
 */
export function useOverlayClickThrough() {
  const onMouseEnter = useCallback(() => {
    window.electronAPI?.setIgnoreMouseEvents(false)
  }, [])

  const onMouseLeave = useCallback(() => {
    window.electronAPI?.setIgnoreMouseEvents(true, { forward: true })
  }, [])

  return { onMouseEnter, onMouseLeave }
}
