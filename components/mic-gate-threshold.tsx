"use client"

// ---------------------------------------------------------------------------
// Gate threshold control: ONE bar that is both the microphone meter and the
// slider. The fill is what the mic hears, the handle is where the gate opens,
// and everything to the left of the handle is what never leaves the machine.
//
// Two separate widgets (an abstract "strength" slider plus a read-only meter)
// forced the user to translate between them; here the handle is dragged
// directly onto the level they want cut off, so "cut half of it" is literally
// dragging to the middle.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { Button } from "@/components/ui/button"
import { meterPositionToDb } from "@/lib/mic-gate"
import { cn } from "@/lib/utils"

/** How long "подобрать" listens to the room before placing the handle. */
const CALIBRATE_MS = 2000
/** Headroom above the loudest noise heard while calibrating, in meter points. */
const CALIBRATE_MARGIN = 6

const TICKS = [0, 25, 50, 75, 100]

interface MicGateThresholdProps {
  /** Threshold position, 0..100 on the meter scale. */
  value: number
  onChange: (value: number) => void
  /** Live microphone level on the same 0..100 scale. */
  level: number
  /** True while the gate is passing audio. */
  open: boolean
  /** True while measurements are actually arriving. */
  live: boolean
  disabled?: boolean
}

export function MicGateThreshold({ value, onChange, level, open, live, disabled }: MicGateThresholdProps) {
  const [dragging, setDragging] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const peak = useRef(0)
  // The dialog passes an inline callback; keeping it in a ref stops the
  // calibration timer from restarting on every render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!calibrating) return
    peak.current = 0
    const timer = setTimeout(() => {
      setCalibrating(false)
      onChangeRef.current(Math.min(100, Math.round(peak.current) + CALIBRATE_MARGIN))
    }, CALIBRATE_MS)
    return () => clearTimeout(timer)
  }, [calibrating])

  useEffect(() => {
    if (calibrating && level > peak.current) peak.current = level
  }, [calibrating, level])

  const handleChange = useCallback(
    (next: number | readonly number[]) => onChange(Array.isArray(next) ? next[0] : (next as number)),
    [onChange],
  )

  const cut = Math.min(level, value)
  const passed = Math.max(0, level - value)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Порог срабатывания</span>
        <span className={cn("text-xs tabular-nums", dragging ? "text-foreground" : "text-muted-foreground")}>
          {value === 0 ? "всё проходит" : `${meterPositionToDb(value)} dB · ${value}%`}
        </span>
      </div>

      <SliderPrimitive.Root
        value={value}
        onValueChange={handleChange}
        onValueCommitted={() => setDragging(false)}
        min={0}
        max={100}
        step={1}
        disabled={disabled}
        thumbAlignment="edge"
        className="w-full"
      >
        <SliderPrimitive.Control
          className="relative flex h-10 w-full touch-none items-center select-none"
          onPointerDown={() => setDragging(true)}
        >
          <SliderPrimitive.Track className="relative h-4 w-full grow overflow-hidden rounded-full bg-muted">
            {/* Everything below the handle: the part of the signal that is cut. */}
            <SliderPrimitive.Indicator className="h-full bg-foreground/10" />
            {/* The mic level, split at the handle so it is obvious which half
                of the sound is being thrown away right now. */}
            <div
              className="absolute inset-y-0 left-0 bg-muted-foreground/40 transition-[width] duration-75"
              style={{ width: `${cut}%` }}
            />
            <div
              className={cn(
                "absolute inset-y-0 transition-[width] duration-75",
                open ? "bg-primary" : "bg-muted-foreground/60",
              )}
              style={{ left: `${value}%`, width: `${passed}%` }}
            />
          </SliderPrimitive.Track>

          <SliderPrimitive.Thumb
            aria-label="Порог шумоподавления"
            className={cn(
              "z-10 flex h-8 w-4 cursor-grab items-center justify-center rounded-md border-2 border-primary bg-background shadow-md",
              "ring-ring/50 transition-shadow select-none after:absolute after:-inset-3",
              "hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:cursor-grabbing active:ring-3",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="h-3 w-0.5 rounded-full bg-primary" aria-hidden="true" />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>

      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums" aria-hidden="true">
        {TICKS.map((tick) => (
          <span key={tick}>{meterPositionToDb(tick)}</span>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Тяните ручку: слева от неё звук отрезается, справа — уходит в комнату.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !live || calibrating}
          onClick={() => setCalibrating(true)}
        >
          {calibrating ? "Слушаю тишину…" : "Подобрать"}
        </Button>
      </div>
    </div>
  )
}
