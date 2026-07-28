"use client"

import { useCallback, useEffect, useRef } from "react"

// ---------------------------------------------------------------------------
// Screen-share annotation canvas.
//
// A transparent <canvas> overlaid on the shared screen. Anyone may draw; every
// stroke is broadcast (in NORMALIZED 0..1 coordinates) so it lands in the same
// spot on every participant's screen regardless of their display size. Strokes
// are kept as vectors and replayed on each render, so resizing stays crisp and
// the eraser (a destination-out stroke) composites deterministically.
//
// Ephemeral by design: nothing is persisted. When the screen share stops the
// parent unmounts the canvas and the drawing is gone.
// ---------------------------------------------------------------------------

export type AnnotationTool = "pen" | "eraser"

interface Point {
  x: number // 0..1, normalized to the canvas width
  y: number // 0..1, normalized to the canvas height
}

export interface AnnotationStroke {
  id: string
  tool: AnnotationTool
  color: string
  // Line width as a fraction of the reference width (1000px), so it scales with
  // the canvas. Kept small (e.g. 0.004 ≈ 4px at 1000px wide).
  lineWidth: number
  points: Point[]
}

interface StreamAnnotationCanvasProps {
  // Whether the LOCAL user can currently draw. When false the canvas still
  // renders remote/own strokes but ignores pointer input (pointer-events:none).
  active: boolean
  // Use a pen-shaped cursor over the annotation canvas. Enabled by default in
  // both browser conferences and the Electron desktop overlay.
  featherCursor?: boolean
  tool: AnnotationTool
  color: string
  // Pen thickness as a fraction of the reference width (see PEN_WIDTH_OPTIONS).
  // Optional so existing callers keep the default medium width.
  penWidth?: number
  // Broadcast one stroke (incremental while drawing, final on pointer up).
  onStroke: (stroke: AnnotationStroke) => void
  // Broadcast a full clear.
  onClear: () => void
  // Register for remote strokes; returns an unsubscribe fn.
  subscribeRemoteStroke: (fn: (stroke: unknown) => void) => () => void
  // Register for remote clears; returns an unsubscribe fn.
  subscribeRemoteClear: (fn: () => void) => () => void
  // A monotonically increasing counter; when it changes we clear locally AND
  // broadcast a clear (used by the toolbar's "clear" button).
  clearSignal: number
}

const REF_WIDTH = 1000
// Selectable pen thicknesses, as a fraction of the reference width (1000px).
// The user picks one from the toolbar; the default is the middle option.
export const PEN_WIDTH_OPTIONS = [0.001, 0.004, 0.008, 0.014] as const
export const DEFAULT_PEN_WIDTH = PEN_WIDTH_OPTIONS[1] // ~4px at 1000px
const ERASER_WIDTH = 0.03 // ~30px at 1000px
// Pen-shaped cursor. Drawn as a long, slim stylus that spans the whole SVG
// diagonal so the pointer reads clearly as "рисование" — the hotspot sits on
// the nib at the bottom-left, exactly where the stroke is laid down.
// 48px canvas (up from 32px) makes the pen noticeably bigger and longer while
// staying well under the browsers' 128px cursor limit.
const CURSOR_SIZE = 48
// Nib position in the 24×24 viewBox is ≈(2.1, 21.9) → scale to the real size.
const CURSOR_HOTSPOT_X = Math.round((2.1 / 24) * CURSOR_SIZE)
const CURSOR_HOTSPOT_Y = Math.round((21.9 / 24) * CURSOR_SIZE)
const FEATHER_CURSOR =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${CURSOR_SIZE}' height='${CURSOR_SIZE}' viewBox='0 0 24 24' fill='%23171717' stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21.17 6.81a1 1 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.36a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z'/%3E%3Cpath d='M15.5 5.5 18.5 8.5' stroke-width='1.2'/%3E%3C/svg%3E") ${CURSOR_HOTSPOT_X} ${CURSOR_HOTSPOT_Y}, crosshair`

export function StreamAnnotationCanvas({
  active,
  featherCursor = true,
  tool,
  color,
  penWidth = DEFAULT_PEN_WIDTH,
  onStroke,
  onClear,
  subscribeRemoteStroke,
  subscribeRemoteClear,
  clearSignal,
}: StreamAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Ordered list of every stroke (local + remote). Replayed on each render.
  const strokesRef = useRef<AnnotationStroke[]>([])
  // The stroke currently being drawn by the local user, if any.
  const drawingRef = useRef<AnnotationStroke | null>(null)
  // Throttle outgoing broadcasts while dragging.
  const lastSentRef = useRef(0)

  // Keep latest tool/color in refs so pointer handlers don't need to rebind.
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const penWidthRef = useRef(penWidth)
  toolRef.current = tool
  colorRef.current = color
  penWidthRef.current = penWidth

  // ----- Rendering ---------------------------------------------------------
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    for (const stroke of strokesRef.current) {
      if (stroke.points.length === 0) continue
      ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over"
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = Math.max(1, stroke.lineWidth * w)

      ctx.beginPath()
      const first = stroke.points[0]
      ctx.moveTo(first.x * w, first.y * h)
      if (stroke.points.length === 1) {
        // A single tap — draw a dot.
        ctx.lineTo(first.x * w + 0.01, first.y * h)
      } else {
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h)
        }
      }
      ctx.stroke()
    }
    ctx.globalCompositeOperation = "source-over"
  }, [])

  // Match the canvas backing store to its CSS size (accounting for DPR) so
  // drawings stay sharp, then re-render.
  const resize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const nextW = Math.max(1, Math.round(rect.width * dpr))
    const nextH = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW
      canvas.height = nextH
    }
    render()
  }, [render])

  useEffect(() => {
    resize()
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [resize])

  // ----- Remote strokes / clears ------------------------------------------
  const upsertStroke = useCallback(
    (incoming: AnnotationStroke) => {
      const list = strokesRef.current
      const idx = list.findIndex((s) => s.id === incoming.id)
      if (idx === -1) list.push(incoming)
      else list[idx] = incoming
      render()
    },
    [render],
  )

  useEffect(() => {
    const unsubStroke = subscribeRemoteStroke((raw) => {
      const stroke = raw as AnnotationStroke
      if (!stroke || typeof stroke.id !== "string" || !Array.isArray(stroke.points)) return
      upsertStroke(stroke)
    })
    const unsubClear = subscribeRemoteClear(() => {
      strokesRef.current = []
      render()
    })
    return () => {
      unsubStroke()
      unsubClear()
    }
  }, [subscribeRemoteStroke, subscribeRemoteClear, upsertStroke, render])

  // ----- Local clear signal ------------------------------------------------
  const firstClearRef = useRef(true)
  useEffect(() => {
    if (firstClearRef.current) {
      firstClearRef.current = false
      return
    }
    strokesRef.current = []
    drawingRef.current = null
    render()
    onClear()
  }, [clearSignal, render, onClear])

  // ----- Pointer drawing ---------------------------------------------------
  const pointFromEvent = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / Math.max(1, rect.width),
      y: (e.clientY - rect.top) / Math.max(1, rect.height),
    }
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!active) return
      e.preventDefault()
      canvasRef.current?.setPointerCapture(e.pointerId)
      const isEraser = toolRef.current === "eraser"
      const stroke: AnnotationStroke = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        tool: toolRef.current,
        color: isEraser ? "#000000" : colorRef.current,
        lineWidth: isEraser ? ERASER_WIDTH : penWidthRef.current,
        points: [pointFromEvent(e)],
      }
      drawingRef.current = stroke
      strokesRef.current.push(stroke)
      render()
      onStroke({ ...stroke, points: [...stroke.points] })
      lastSentRef.current = Date.now()
    },
    [active, pointFromEvent, render, onStroke],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const stroke = drawingRef.current
      if (!active || !stroke) return
      e.preventDefault()
      stroke.points.push(pointFromEvent(e))
      render()
      // Throttle network sends to ~33/sec; always include the full point list
      // so a dropped packet self-heals on the next send.
      const now = Date.now()
      if (now - lastSentRef.current >= 30) {
        onStroke({ ...stroke, points: [...stroke.points] })
        lastSentRef.current = now
      }
    },
    [active, pointFromEvent, render, onStroke],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const stroke = drawingRef.current
      if (!stroke) return
      e.preventDefault()
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId)
      } catch {
        // ignore — capture may not be held
      }
      // Final authoritative broadcast of the completed stroke.
      onStroke({ ...stroke, points: [...stroke.points] })
      drawingRef.current = null
    },
    [onStroke],
  )

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      style={{
        pointerEvents: active ? "auto" : "none",
        cursor: active ? (featherCursor ? FEATHER_CURSOR : "crosshair") : "default",
        touchAction: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )
}
