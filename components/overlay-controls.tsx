"use client"

import { useState, useRef, useEffect } from "react"
import { Mic, MicOff, Video, VideoOff, MonitorOff, Pencil, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useOverlayClickThrough } from "@/hooks/use-overlay-click-through"

interface OverlayControlsProps {
  isMicMuted: boolean
  isCamOff: boolean
  // Рисование поверх демонстрации экрана (в overlay-режиме). Когда активно —
  // показывается тулбар, а полноэкранный холст перехватывает клики мыши.
  annotationActive: boolean
  onToggleAnnotation: () => void
  onToggleMic: () => void
  onToggleCam: () => void
  onStopScreenShare: () => void
}

/**
 * Плавающая панель управления в overlay-режиме (демонстрация экрана).
 * Закреплена снизу по центру, всегда поверх содержимого.
 * Показывает только: микрофон, камера, рисование, остановить демонстрацию.
 *
 * Панель можно скрыть/показать стрелкой-«язычком» — так же, как нижняя
 * панель в веб-версии (RoomControls). В свёрнутом состоянии сама панель
 * уезжает за нижнюю кромку экрана, а наверху остаётся только язычок со
 * стрелкой, по клику на который панель возвращается.
 */
export function OverlayControls({
  isMicMuted,
  isCamOff,
  annotationActive,
  onToggleAnnotation,
  onToggleMic,
  onToggleCam,
  onStopScreenShare,
}: OverlayControlsProps) {
  const clickThrough = useOverlayClickThrough()
  const [collapsed, setCollapsed] = useState(false)

  // Измеряем высоту панели, чтобы при сворачивании опустить группу ровно на
  // (высота панели + отступ снизу). Тогда панель полностью прячется за кромку
  // экрана, а язычок-стрелка остаётся прижатым к нижнему краю и видимым.
  const barRef = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(0)

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const update = () => setBarHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // bottom-6 == 24px
  const hideOffset = barHeight + 24

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[9999] flex justify-center">
      <div
        className="relative transition-transform duration-300 ease-in-out"
        style={{ transform: collapsed ? `translateY(${hideOffset}px)` : undefined }}
      >
        {/* Язычок-стрелка — всегда поверх панели, остаётся виден когда панель
            свёрнута. */}
        <div className="absolute -top-7 left-1/2 -translate-x-1/2">
          <button
            {...clickThrough}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Показать панель управления" : "Скрыть панель управления"}
            className="pointer-events-auto flex h-7 w-14 items-center justify-center rounded-t-xl border border-b-0 border-white/10 bg-black/70 backdrop-blur-xl transition-colors hover:bg-white/10"
          >
            <ChevronUp
              className={cn(
                "size-4 text-white transition-transform duration-300",
                !collapsed && "rotate-180",
              )}
            />
          </button>
        </div>

        {/* Сама панель управления */}
        <div
          ref={barRef}
          {...clickThrough}
          className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 shadow-2xl backdrop-blur-xl"
        >
          {/* Mic */}
          <button
            onClick={onToggleMic}
            aria-label={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
            className={cn(
              "flex size-11 items-center justify-center rounded-full border transition-colors",
              isMicMuted
                ? "border-red-500/60 bg-red-500/20 text-red-400 hover:bg-red-500/30"
                : "border-white/10 bg-white/5 text-white hover:bg-white/10",
            )}
          >
            {isMicMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </button>

          {/* Camera */}
          <button
            onClick={onToggleCam}
            aria-label={isCamOff ? "Включить камеру" : "Выключить камеру"}
            className={cn(
              "flex size-11 items-center justify-center rounded-full border transition-colors",
              isCamOff
                ? "border-red-500/60 bg-red-500/20 text-red-400 hover:bg-red-500/30"
                : "border-white/10 bg-white/5 text-white hover:bg-white/10",
            )}
          >
            {isCamOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
          </button>

          {/* Annotation (рисование поверх экрана) */}
          <button
            onClick={onToggleAnnotation}
            aria-label={annotationActive ? "Закрыть рисование по экрану" : "Рисовать по экрану"}
            className={cn(
              "flex size-11 items-center justify-center rounded-full border transition-colors",
              annotationActive
                ? "border-white/60 bg-white/20 text-white hover:bg-white/30"
                : "border-white/10 bg-white/5 text-white hover:bg-white/10",
            )}
          >
            <Pencil className="size-5" />
          </button>

          {/* Divider */}
          <div className="h-8 w-px bg-white/10" aria-hidden="true" />

          {/* Stop screen share */}
          <button
            onClick={onStopScreenShare}
            aria-label="Остановить демонстрацию экрана"
            className="flex h-11 items-center gap-2 rounded-full border border-red-500/60 bg-red-500/20 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/30"
          >
            <MonitorOff className="size-4 shrink-0" />
            <span>Остановить демонстрацию</span>
          </button>
        </div>
      </div>
    </div>
  )
}
