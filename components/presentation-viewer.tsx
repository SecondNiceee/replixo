"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { ChevronLeft, ChevronRight, X, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SlideState } from "@/hooks/use-mediasoup"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresentationViewerProps {
  /** Whether the local user is the presenter (shows navigation + stop controls). */
  isPresenter: boolean
  /** Current slide state — synced for viewers, owned locally for presenter. */
  currentSlide: SlideState | null
  /** Called when presenter navigates: (slideIndex, total). */
  onSlideChange?: (slide: number, total: number) => void
  /** Called when the presenter clicks "Завершить". */
  onStop?: () => void
  /**
   * For the presenter: the canvas we render slides into and capture.
   * The parent creates the canvas + calls captureStream() + startPresentation().
   */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>
  /** For viewers: the MediaStream captured from the presenter's canvas. */
  remoteStream?: MediaStream
  /** The file selected by the presenter. */
  file?: File | null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PresentationViewer({
  isPresenter,
  currentSlide,
  onSlideChange,
  onStop,
  canvasRef,
  remoteStream,
  file,
}: PresentationViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  // Wire viewer stream into <video>
  useEffect(() => {
    const video = videoRef.current
    if (!video || !remoteStream) return
    video.srcObject = remoteStream
  }, [remoteStream])

  const slide = currentSlide?.slide ?? 0
  const total = currentSlide?.total ?? 0

  const goNext = useCallback(() => {
    if (!isPresenter || !onSlideChange || !currentSlide) return
    if (slide + 1 < total) onSlideChange(slide + 1, total)
  }, [isPresenter, onSlideChange, currentSlide, slide, total])

  const goPrev = useCallback(() => {
    if (!isPresenter || !onSlideChange || !currentSlide) return
    if (slide > 0) onSlideChange(slide - 1, total)
  }, [isPresenter, onSlideChange, currentSlide, slide, total])

  // Keyboard navigation for presenter
  useEffect(() => {
    if (!isPresenter) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault()
        goNext()
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault()
        goPrev()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isPresenter, goNext, goPrev])

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-black">
      {/* Main content */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        {isPresenter ? (
          canvasRef ? (
            <PresenterCanvas
              canvasRef={canvasRef}
              file={file ?? null}
              slideIndex={slide}
              onLoaded={(t) => onSlideChange?.(0, t)}
            />
          ) : null
        ) : remoteStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-contain"
          />
        ) : (
          <EmptySlate label="Ожидание презентации…" />
        )}
      </div>

      {/* Controls bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 bg-black/80 px-4 py-2 backdrop-blur-sm">
        {/* Stop button */}
        <div className="flex w-28 items-center">
          {isPresenter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onStop}
              className="h-8 gap-1.5 px-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X className="size-3.5" />
              Завершить
            </Button>
          )}
        </div>

        {/* Slide counter + arrows */}
        <div className="flex items-center gap-3">
          <button
            onClick={goPrev}
            disabled={!isPresenter || slide <= 0}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              isPresenter && slide > 0
                ? "text-white hover:bg-white/15"
                : "cursor-default text-white/20",
            )}
            aria-label="Предыдущий слайд"
          >
            <ChevronLeft className="size-5" />
          </button>

          <span className="min-w-[56px] text-center text-sm font-medium tabular-nums text-white/80">
            {total > 0 ? `${slide + 1} / ${total}` : "—"}
          </span>

          <button
            onClick={goNext}
            disabled={!isPresenter || slide + 1 >= total}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              isPresenter && slide + 1 < total
                ? "text-white hover:bg-white/15"
                : "cursor-default text-white/20",
            )}
            aria-label="Следующий слайд"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        {/* Spacer */}
        <div className="w-28" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PresenterCanvas — renders PDF pages (or PPTX slides) into the offscreen
// canvas and displays a live preview copy. Navigation is driven by slideIndex
// from the parent so that state stays in page.tsx and notifySlideChange is
// called correctly.
// ---------------------------------------------------------------------------

interface PresenterCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  file: File | null
  slideIndex: number
  /** Called once after the file is loaded with the total page/slide count. */
  onLoaded: (total: number) => void
}

function PresenterCanvas({ canvasRef, file, slideIndex, onLoaded }: PresenterCanvasProps) {
  const previewRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  // Stable refs so the render callbacks don't recreate on every render
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null)
  // Array of pre-rendered canvas snapshots for PPTX slides
  const pptxCanvasesRef = useRef<HTMLCanvasElement[]>([])
  const fileTypeRef = useRef<"pdf" | "pptx" | null>(null)
  const loadedRef = useRef(false)

  // -----------------------------------------------------------------------
  // Draw a rendered source onto offscreen + preview canvases
  // -----------------------------------------------------------------------
  const paintCanvas = useCallback(
    (source: HTMLCanvasElement | ImageBitmap) => {
      const offscreen = canvasRef.current
      const preview = previewRef.current
      if (!offscreen || !preview) return

      const w = "width" in source ? source.width : source.width
      const h = "height" in source ? source.height : source.height

      offscreen.width = w
      offscreen.height = h
      preview.width = w
      preview.height = h

      const oCtx = offscreen.getContext("2d")!
      oCtx.drawImage(source as CanvasImageSource, 0, 0)

      const pCtx = preview.getContext("2d")!
      pCtx.drawImage(source as CanvasImageSource, 0, 0)
    },
    [canvasRef],
  )

  // -----------------------------------------------------------------------
  // PDF: render page slideIndex
  // -----------------------------------------------------------------------
  const renderPdfPage = useCallback(
    async (pageIndex: number) => {
      const pdf = pdfDocRef.current
      if (!pdf) return
      const page = await pdf.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 2 })

      const tmp = document.createElement("canvas")
      tmp.width = viewport.width
      tmp.height = viewport.height
      const ctx = tmp.getContext("2d")!
      await page.render({ canvasContext: ctx, viewport }).promise
      paintCanvas(tmp)
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // PPTX: paint pre-rendered slide at pageIndex
  // -----------------------------------------------------------------------
  const renderPptxSlide = useCallback(
    (index: number) => {
      const c = pptxCanvasesRef.current[index]
      if (c) paintCanvas(c)
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // Load file on mount / file change
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!file) return
    loadedRef.current = false
    pdfDocRef.current = null
    pptxCanvasesRef.current = []
    fileTypeRef.current = null
    setError(null)

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")

    if (isPdf) {
      fileTypeRef.current = "pdf"
      loadPdf(file)
    } else {
      fileTypeRef.current = "pptx"
      loadPptx(file)
    }

    async function loadPdf(f: File) {
      try {
        const pdfjsLib = await import("pdfjs-dist")
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString()

        const buf = await f.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise
        pdfDocRef.current = pdf
        loadedRef.current = true
        onLoaded(pdf.numPages)
      } catch (err) {
        setError("Ошибка PDF: " + (err instanceof Error ? err.message : String(err)))
      }
    }

    async function loadPptx(f: File) {
      try {
        const [{ default: PptxViewer }, html2canvasMod] = await Promise.all([
          import("pptx-preview"),
          import("html2canvas-pro"),
        ])
        const html2canvas = html2canvasMod.default

        const buf = await f.arrayBuffer()

        // Render PPTX into an off-screen container
        const container = document.createElement("div")
        container.style.cssText =
          "position:fixed;left:-9999px;top:0;width:1280px;height:720px;" +
          "background:#fff;overflow:hidden;z-index:-1;"
        document.body.appendChild(container)

        await PptxViewer(container, { width: "1280px", height: "720px" }, buf)

        const sections = Array.from(container.querySelectorAll("section"))
        const total = sections.length

        // Pre-render every slide to an independent canvas so navigation is instant
        const canvases: HTMLCanvasElement[] = []
        for (let i = 0; i < sections.length; i++) {
          sections.forEach((s, j) => {
            ;(s as HTMLElement).style.display = j === i ? "block" : "none"
          })
          const snap = await html2canvas(container as HTMLElement, {
            useCORS: true,
            scale: 2,
            width: 1280,
            height: 720,
          })
          canvases.push(snap)
        }

        document.body.removeChild(container)

        pptxCanvasesRef.current = canvases
        loadedRef.current = true
        onLoaded(total)
      } catch (err) {
        setError("Ошибка PPTX: " + (err instanceof Error ? err.message : String(err)))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  // -----------------------------------------------------------------------
  // Re-render whenever slideIndex changes (or after file loads)
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!loadedRef.current) return
    if (fileTypeRef.current === "pdf") {
      renderPdfPage(slideIndex)
    } else if (fileTypeRef.current === "pptx") {
      renderPptxSlide(slideIndex)
    }
  }, [slideIndex, renderPdfPage, renderPptxSlide])

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 text-center text-red-400">
        <FileText className="size-8" />
        <span className="text-sm">{error}</span>
      </div>
    )
  }

  if (!file) {
    return <EmptySlate label="Файл не выбран" />
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      <canvas
        ref={previewRef}
        className="max-h-full max-w-full rounded object-contain shadow-lg"
        style={{ background: "#ffffff" }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function EmptySlate({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-white/40">
      <FileText className="size-10" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
