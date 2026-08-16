"use client"

import { useEffect, useState } from "react"

/**
 * Прямоугольник демонстрируемого источника в координатах содержимого
 * overlay-окна (CSS-пиксели). Считает main-процесс (electron/capture-region.js).
 *
 * Нужен, потому что overlay-окно накрывает ВЕСЬ дисплей, а зрители видят только
 * захваченный источник. Ограничив канвас этим прямоугольником, мы приводим
 * нормализованные (0..1) координаты штрихов к одной и той же системе координат
 * у всех участников — рисование совпадает с контентом и при демонстрации окна,
 * занимающего часть экрана.
 *
 * Вне Electron (в браузере) всегда null: там канвас лежит на самом <video>,
 * и координаты совпадают сами по себе.
 */
export function useCaptureRegion(enabled: boolean): CaptureRegion | null {
  const [region, setRegion] = useState<CaptureRegion | null>(null)

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (!enabled || typeof api?.onCaptureRegionChanged !== "function") {
      setRegion(null)
      return
    }

    let stopped = false
    // Стартовое значение, чтобы канвас не мигнул на весь экран до первого тика.
    api.getCaptureRegion?.()
      .then((initial) => {
        if (!stopped && initial) setRegion(initial)
      })
      .catch(() => {
        // Регион остаётся null → поведение как раньше (весь экран).
      })

    const unsubscribe = api.onCaptureRegionChanged((next) => {
      if (!stopped) setRegion(next)
    })

    return () => {
      stopped = true
      unsubscribe()
      setRegion(null)
    }
  }, [enabled])

  return region
}
