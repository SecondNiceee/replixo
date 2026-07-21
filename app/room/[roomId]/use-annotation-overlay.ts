"use client"

import { useState, useCallback, useEffect } from "react"
import { OVERLAY_INTERACTIVE_ATTR, useOverlayMouseManager } from "@/hooks/use-overlay-click-through"
import { DEFAULT_PEN_WIDTH, type AnnotationTool } from "@/components/stream-annotation-canvas"
import type { RemotePeer } from "@/hooks/use-mediasoup"
import { useAnnotationSettingsStore } from "@/stores/annotation-settings-store"
import { useAnnotationSettingsSync } from "@/hooks/use-annotation-settings-sync"

interface UseAnnotationOverlayArgs {
  isScreenSharing: boolean
  peers: Map<string, RemotePeer>
}

interface UseAnnotationOverlayResult {
  canAnnotate: boolean
  annotationActive: boolean
  annotationTool: AnnotationTool
  annotationColor: string
  annotationPenWidth: number
  annotationClearSignal: number
  setAnnotationTool: (tool: AnnotationTool) => void
  setAnnotationColor: (color: string) => void
  setAnnotationPenWidth: (width: number) => void
  setAnnotationActive: (active: boolean) => void
  toggleAnnotation: () => void
  triggerAnnotationClear: () => void
  isElectron: boolean
  overlayMode: boolean
}

/**
 * Manages screen-share annotation state (drawing over the shared stream) and
 * the Electron overlay-mode lifecycle. Annotation is only available while a
 * screen is being shared (local or remote); the overlay makes the desktop app
 * window transparent and always-on-top while the local user shares a screen.
 */
export function useAnnotationOverlay({
  isScreenSharing,
  peers,
}: UseAnnotationOverlayArgs): UseAnnotationOverlayResult {
  // Screen-share annotation (рисование поверх стрима). Доступно только пока идёт
  // демонстрация экрана — своя или чужая.
  const hasRemoteScreen = [...peers.values()].some((p) => p.screenStream != null)
  const canAnnotate = isScreenSharing || hasRemoteScreen
  const [annotationActive, setAnnotationActive] = useState(false)
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pen")
  const [annotationColor, setAnnotationColor] = useState("#ef4444")
  const [annotationPenWidth, setAnnotationPenWidth] = useState<number>(DEFAULT_PEN_WIDTH)
  // Bump to broadcast a full clear of all annotations.
  const [annotationClearSignal, setAnnotationClearSignal] = useState(0)
  const activation = useAnnotationSettingsStore((state) => state.activation)
  const hotkey = useAnnotationSettingsStore((state) => state.hotkey)
  useAnnotationSettingsSync()

  // If the screen share ends, leave annotation mode so a dead canvas/toolbar
  // doesn't linger.
  useEffect(() => {
    if (!canAnnotate && annotationActive) setAnnotationActive(false)
  }, [canAnnotate, annotationActive])

  const toggleAnnotation = useCallback(() => setAnnotationActive((v) => !v), [])
  const triggerAnnotationClear = useCallback(() => setAnnotationClearSignal((n) => n + 1), [])

  useEffect(() => {
    if (!canAnnotate) return

    const isBlockedTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false
      return Boolean(target.closest("button, a, input, textarea, select, [role='dialog'], [contenteditable='true']"))
    }
    const handleDoubleClick = (event: MouseEvent) => {
      if (activation !== "double-click" || isBlockedTarget(event.target)) return
      toggleAnnotation()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activation !== "hotkey" || !hotkey || event.code !== hotkey) return
      if (event.repeat || event.isComposing || event.keyCode === 229 || isBlockedTarget(event.target)) return
      event.preventDefault()
      toggleAnnotation()
    }

    // Capture the gesture before video/canvas handlers can consume it. This is
    // especially important in the desktop client, where the screen tile and the
    // annotation canvas sit in separate overlay layers.
    document.addEventListener("dblclick", handleDoubleClick, true)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("dblclick", handleDoubleClick, true)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [activation, canAnnotate, hotkey, toggleAnnotation])

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (
      !isScreenSharing
      || activation !== "double-click"
      || typeof api?.onGlobalDoubleClick !== "function"
    ) return

    return api.onGlobalDoubleClick((point) => {
      // Если окно временно перехватывает мышь над контролами/canvas, обычный
      // DOM dblclick уже обработает жест. Native-событие нужно только над
      // click-through частью overlay, иначе перо переключилось бы дважды.
      const target = document.elementFromPoint(point.x, point.y)
      if (target?.closest(`[${OVERLAY_INTERACTIVE_ATTR}]`)) return
      toggleAnnotation()
    })
  }, [activation, isScreenSharing, toggleAnnotation])

  // Electron overlay-режим: активируется когда мы сами демонстрируем экран.
  // Окно становится прозрачным и всегда поверх — видим только сайдбар + контролы.
  const isElectron = typeof window !== "undefined" && !!window.electronAPI?.isElectron
  const [overlayMode, setOverlayMode] = useState(false)

  useEffect(() => {
    if (!isElectron) return
    if (isScreenSharing) {
      // Сначала делаем документ прозрачным (data-overlay), затем растягиваем
      // окно поверх экрана — чтобы не мелькнул непрозрачный фон.
      document.documentElement.dataset.overlay = "1"
      window.electronAPI!.enterOverlayMode()
      setOverlayMode(true)
    } else {
      window.electronAPI!.exitOverlayMode()
      delete document.documentElement.dataset.overlay
      setOverlayMode(false)
    }
    return () => {
      // Подстраховка при размонтировании (например, выход из комнаты во время показа)
      delete document.documentElement.dataset.overlay
    }
  }, [isScreenSharing, isElectron])

  // Глобальный менеджер click-through: пока активен overlay, клики проходят на
  // рабочий стол, кроме интерактивных областей (контролы, сайдбар участников).
  useOverlayMouseManager(overlayMode)

  return {
    canAnnotate,
    annotationActive,
    annotationTool,
    annotationColor,
    annotationPenWidth,
    annotationClearSignal,
    setAnnotationTool,
    setAnnotationColor,
    setAnnotationPenWidth,
    setAnnotationActive,
    toggleAnnotation,
    triggerAnnotationClear,
    isElectron,
    overlayMode,
  }
}
