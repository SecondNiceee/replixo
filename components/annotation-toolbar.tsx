"use client"

import { Pencil, Eraser, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AnnotationTool } from "@/components/stream-annotation-canvas"

// Compact floating toolbar shown while annotation mode is active. Lets the user
// switch between pen/eraser, pick a colour, clear all annotations, or exit.

const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff"] as const

interface AnnotationToolbarProps {
  tool: AnnotationTool
  color: string
  onToolChange: (tool: AnnotationTool) => void
  onColorChange: (color: string) => void
  onClear: () => void
  onClose: () => void
}

export function AnnotationToolbar({
  tool,
  color,
  onToolChange,
  onColorChange,
  onClear,
  onClose,
}: AnnotationToolbarProps) {
  return (
    <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/15 bg-black/80 px-2 py-1.5 shadow-2xl backdrop-blur-md">
      {/* Pen */}
      <button
        onClick={() => onToolChange("pen")}
        aria-label="Карандаш"
        className={cn(
          "flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10",
          tool === "pen" && "bg-white/15 text-white",
        )}
      >
        <Pencil className="size-5" />
      </button>

      {/* Eraser */}
      <button
        onClick={() => onToolChange("eraser")}
        aria-label="Ластик"
        className={cn(
          "flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10",
          tool === "eraser" && "bg-white/15 text-white",
        )}
      >
        <Eraser className="size-5" />
      </button>

      <div className="mx-0.5 h-6 w-px bg-white/15" />

      {/* Colour swatches */}
      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => {
              onColorChange(c)
              onToolChange("pen")
            }}
            aria-label={`Цвет ${c}`}
            className={cn(
              "size-6 rounded-full border border-white/30 transition-transform hover:scale-110",
              tool === "pen" && color === c && "ring-2 ring-white ring-offset-2 ring-offset-black",
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      <div className="mx-0.5 h-6 w-px bg-white/15" />

      {/* Clear all */}
      <button
        onClick={onClear}
        aria-label="Очистить всё"
        className="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-destructive/20 hover:text-destructive"
      >
        <Trash2 className="size-5" />
      </button>

      {/* Close annotation mode */}
      <button
        onClick={onClose}
        aria-label="Закрыть рисование"
        className="flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
