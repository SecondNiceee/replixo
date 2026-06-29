"use client"

import { Mic, MicOff, Video, VideoOff, MonitorOff } from "lucide-react"
import { cn } from "@/lib/utils"

interface OverlayControlsProps {
  isMicMuted: boolean
  isCamOff: boolean
  onToggleMic: () => void
  onToggleCam: () => void
  onStopScreenShare: () => void
}

/**
 * Плавающая панель управления в overlay-режиме (демонстрация экрана).
 * Закреплена снизу по центру, всегда поверх содержимого.
 * Показывает только: микрофон, камера, остановить демонстрацию.
 */
export function OverlayControls({
  isMicMuted,
  isCamOff,
  onToggleMic,
  onToggleCam,
  onStopScreenShare,
}: OverlayControlsProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[9999] flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 bg-black/70 px-4 py-3 shadow-2xl backdrop-blur-xl">
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
  )
}
