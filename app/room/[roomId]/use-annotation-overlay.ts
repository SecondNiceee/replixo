"use client"

import { useState, useCallback, useEffect } from "react"
import { useOverlayMouseManager } from "@/hooks/use-overlay-click-through"
import type { AnnotationTool } from "@/components/stream-annotation-canvas"
import type { RemotePeer } from "@/hooks/use-mediasoup"

interface UseAnnotationOverlayArgs {
  isScreenSharing: boolean
  peers: Map<string, RemotePeer>
}

interface UseAnnotationOverlayResult {
  canAnnotate: boolean
  annotationActive: boolean
  annotationTool: AnnotationTool
  annotationColor: string
  annotationClearSignal: number
  setAnnotationTool: (tool: AnnotationTool) => void
  setAnnotationColor: (color: string) => void
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
  // Bump to broadcast a full clear of all annotations.
  const [annotationClearSignal, setAnnotationClearSignal] = useState(0)

  // If the screen share ends, leave annotation mode so a dead canvas/toolbar
  // doesn't linger.
  useEffect(() => {
    if (!canAnnotate && annotationActive) setAnnotationActive(false)
  }, [canAnnotate, annotationActive])

  const toggleAnnotation = useCallback(() => setAnnotationActive((v) => !v), [])
  const triggerAnnotationClear = useCallback(() => setAnnotationClearSignal((n) => n + 1), [])

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
    annotationClearSignal,
    setAnnotationTool,
    setAnnotationColor,
    setAnnotationActive,
    toggleAnnotation,
    triggerAnnotationClear,
    isElectron,
    overlayMode,
  }
}
