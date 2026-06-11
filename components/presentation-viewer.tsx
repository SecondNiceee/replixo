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
   * The parent creates the canvas, calls captureStream(), then startPresentation().
   */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>
  /** For viewers: the MediaStream captured from the presenter's canvas. */
  remoteStream?: MediaStream
  /** The file selected by the presenter. */
  file?: File | null
}

// ---------------------------------------------------------------------------
// PresentationViewer
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

  // Wire viewer stream into <video> and autoplay.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !remoteStream) return
    video.srcObject = remoteStream
    video.play().catch(() => {
      // Autoplay may be blocked — the EnableSoundBanner in the parent handles it.
    })
    return () => {
      video.srcObject = null
    }
  }, [remoteStream])

  const slide = currentSlide?.slide ?? 0
  const total = currentSlide?.total ?? 0

  const goNext = useCallback(() => {
    if (!isPresenter || !onSlideChange || total === 0) return
    if (slide + 1 < total) onSlideChange(slide + 1, total)
  }, [isPresenter, onSlideChange, slide, total])

  const goPrev = useCallback(() => {
    if (!isPresenter || !onSlideChange || total === 0) return
    if (slide > 0) onSlideChange(slide - 1, total)
  }, [isPresenter, onSlideChange, slide, total])

  // Keyboard navigation for the presenter only.
  useEffect(() => {
    if (!isPresenter) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
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

  const canGoBack = isPresenter && slide > 0
  const canGoForward = isPresenter && total > 0 && slide + 1 < total

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-black">
      {/* Main content */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
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
        {/* Stop button — only for presenter */}
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
            disabled={!canGoBack}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              canGoBack
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
            disabled={!canGoForward}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              canGoForward
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
// PresenterCanvas
// Renders PDF pages (pdfjs-dist) or PPTX slides (pptx-preview + html2canvas-pro)
// into the offscreen canvas (passed via canvasRef so the parent can captureStream)
// and also draws a live preview into a local visible canvas.
// ---------------------------------------------------------------------------

interface PresenterCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  file: File | null
  slideIndex: number
  /** Called once after the file is loaded with the total slide count. */
  onLoaded: (total: number) => void
}

function PresenterCanvas({ canvasRef, file, slideIndex, onLoaded }: PresenterCanvasProps) {
  const previewRef = useRef<HTMLCanvasElement>(null)
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Stable mutable refs — avoid re-creating callbacks on every render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxPreviewerRef = useRef<any>(null)
  const fileTypeRef = useRef<"pdf" | "pptx" | null>(null)
  const loadedRef = useRef(false)
  // Abort signal so in-flight loads are cancelled when the file changes.
  const abortRef = useRef<AbortController | null>(null)
  // Keep a stable reference to onLoaded so the effect dep array stays clean.
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  // -----------------------------------------------------------------------
  // Paint a source canvas into both the offscreen capture canvas and the
  // visible preview canvas.
  // -----------------------------------------------------------------------
  const paintCanvas = useCallback(
    (source: HTMLCanvasElement) => {
      const offscreen = canvasRef.current
      const preview = previewRef.current
      if (!offscreen || !preview) return

      offscreen.width = source.width
      offscreen.height = source.height
      preview.width = source.width
      preview.height = source.height

      offscreen.getContext("2d")!.drawImage(source, 0, 0)
      preview.getContext("2d")!.drawImage(source, 0, 0)
    },
    [canvasRef],
  )

  // -----------------------------------------------------------------------
  // PDF helpers
  // -----------------------------------------------------------------------
  const renderPdfPage = useCallback(
    async (pageIndex: number, signal: AbortSignal) => {
      const pdf = pdfDocRef.current
      if (!pdf || signal.aborted) return
      const page = await pdf.getPage(pageIndex + 1)
      if (signal.aborted) return

      const viewport = page.getViewport({ scale: 2 })
      const tmp = document.createElement("canvas")
      tmp.width = viewport.width
      tmp.height = viewport.height
      await page.render({ canvasContext: tmp.getContext("2d")!, viewport }).promise
      if (signal.aborted) return
      paintCanvas(tmp)
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // PPTX helpers
  // -----------------------------------------------------------------------
  const renderPptxSlide = useCallback(
    (index: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const canvases: HTMLCanvasElement[] | undefined = (pptxPreviewerRef.current as any)?._v0Canvases
      const c = canvases?.[index]
      if (c) paintCanvas(c)
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // Load file whenever it changes.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!file) return

    // Cancel any previous in-flight load.
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    // Tear down previous PPTX previewer instance.
    if (pptxPreviewerRef.current) {
      try { pptxPreviewerRef.current.destroy() } catch { /* ignore */ }
      pptxPreviewerRef.current = null
    }

    // Reset state.
    loadedRef.current = false
    pdfDocRef.current = null
    fileTypeRef.current = null
    setError(null)

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")

    if (isPdf) {
      fileTypeRef.current = "pdf"
      loadPdf(file, abort.signal)
    } else {
      fileTypeRef.current = "pptx"
      loadPptx(file, abort.signal)
    }

    return () => {
      abort.abort()
    }
  }, [file]) // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // PDF loader
  // -----------------------------------------------------------------------
  async function loadPdf(f: File, signal: AbortSignal) {
    setLoadingMsg("Загрузка PDF…")
    try {
      const pdfjsLib = await import("pdfjs-dist")
      if (signal.aborted) return

      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString()

      const buf = await f.arrayBuffer()
      if (signal.aborted) return

      // Keep the loading task so we can destroy it on abort/cleanup.
      const loadingTask = pdfjsLib.getDocument({ data: buf })
      if (signal.aborted) {
        void loadingTask.destroy()
        return
      }

      const pdf = await loadingTask.promise
      if (signal.aborted) {
        void loadingTask.destroy()
        return
      }

      pdfDocRef.current = pdf
      loadedRef.current = true
      setLoadingMsg(null)
      onLoadedRef.current(pdf.numPages)
      // Render first page immediately.
      await renderPdfPage(0, signal)
    } catch (err) {
      if (signal.aborted) return
      setLoadingMsg(null)
      setError("Ошибка PDF: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  // -----------------------------------------------------------------------
  // PPTX loader — uses pptx-preview's class-based API:
  //   init(dom, options) → PPTXPreviewer
  //   previewer.load(ArrayBuffer) → Promise
  //   previewer.renderSingleSlide(index)
  //   previewer.slideCount
  //   previewer.destroy()
  // We pre-render every slide to an off-screen canvas via html2canvas-pro so
  // that navigation is instant and doesn't depend on DOM visibility tricks.
  // -----------------------------------------------------------------------
  async function loadPptx(f: File, signal: AbortSignal) {
    setLoadingMsg("Загрузка PPTX…")
    let container: HTMLDivElement | null = null
    try {
      const [pptxMod, html2canvasMod] = await Promise.all([
        import("pptx-preview"),
        import("html2canvas-pro"),
      ])
      if (signal.aborted) return
      const html2canvas = html2canvasMod.default

      const buf = await f.arrayBuffer()
      if (signal.aborted) return

      // Mount an off-screen container for the previewer.
      container = document.createElement("div")
      container.style.cssText =
        "position:fixed;left:-9999px;top:0;width:1280px;height:720px;" +
        "background:#fff;overflow:hidden;z-index:-1;"
      document.body.appendChild(container)

      const previewer = pptxMod.init(container, { width: 1280, height: 720, mode: "slide" })
      pptxPreviewerRef.current = previewer

      await previewer.load(buf)
      if (signal.aborted) return

      const total = previewer.slideCount
      if (total === 0) throw new Error("Не найдено слайдов в файле")

      const canvases: HTMLCanvasElement[] = []

      for (let i = 0; i < total; i++) {
        if (signal.aborted) break
        setLoadingMsg(`Обработка слайда ${i + 1} / ${total}…`)
        previewer.renderSingleSlide(i)
        // Small yield so the DOM paints before snapshot.
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        if (signal.aborted) break
        const snap = await html2canvas(container, {
          useCORS: true,
          scale: 2,
          width: 1280,
          height: 720,
        })
        canvases.push(snap)
      }

      if (signal.aborted) return

      loadedRef.current = true
      setLoadingMsg(null)
      onLoadedRef.current(total)
      // Paint the first slide into both canvases immediately.
      paintCanvas(canvases[0])

      // Store canvases for fast navigation later.
      // We reuse pptxPreviewerRef slot for slide canvases.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(pptxPreviewerRef.current as any)._v0Canvases = canvases
    } catch (err) {
      if (signal.aborted) return
      setLoadingMsg(null)
      setError("Ошибка PPTX: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      if (container && document.body.contains(container)) {
        document.body.removeChild(container)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Re-render whenever slideIndex changes (after the file is loaded).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!loadedRef.current) return
    const abort = abortRef.current ?? new AbortController()
    if (fileTypeRef.current === "pdf") {
      renderPdfPage(slideIndex, abort.signal)
    } else if (fileTypeRef.current === "pptx") {
      renderPptxSlide(slideIndex)
    }
  }, [slideIndex, renderPdfPage, renderPptxSlide])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
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
    <div className="relative flex h-full w-full items-center justify-center p-3">
      <canvas
        ref={previewRef}
        className="max-h-full max-w-full rounded object-contain shadow-lg"
        style={{ background: "#ffffff" }}
      />
      {loadingMsg && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 rounded-2xl">
          <div className="size-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span className="text-sm text-white/80">{loadingMsg}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EmptySlate
// ---------------------------------------------------------------------------

function EmptySlate({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-white/40">
      <FileText className="size-10" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
