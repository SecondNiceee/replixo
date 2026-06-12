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
   * The parent creates the canvas offscreen, calls captureStream(), then
   * startPresentation().
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

  // Wire viewer stream into <video> and autoplay only when there are tracks.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!remoteStream || remoteStream.getTracks().length === 0) {
      video.srcObject = null
      return
    }
    video.srcObject = remoteStream
    // play() is a no-op if already playing; catch DOMException on autoplay block.
    video.play().catch(() => {
      // Autoplay may be blocked — the EnableSoundBanner in the parent handles it.
    })
    return () => {
      video.srcObject = null
    }
  }, [remoteStream])

  // Optimistic slide index: updated immediately on arrow click so the canvas
  // re-renders without waiting for the server round-trip (notifySlideChange
  // emits to the server which echoes back via SET_SLIDE, which can take 50-200ms).
  // We sync it back to the authoritative currentSlide whenever the server acks.
  const serverSlide = currentSlide?.slide ?? 0
  const total = currentSlide?.total ?? 0
  const [optimisticSlide, setOptimisticSlide] = useState(serverSlide)

  // Keep optimistic in sync when server delivers an authoritative update.
  useEffect(() => {
    setOptimisticSlide(serverSlide)
  }, [serverSlide])

  // Use optimistic for presenter (instant feedback), server value for viewers.
  const slide = isPresenter ? optimisticSlide : serverSlide

  const goNext = useCallback(() => {
    if (!isPresenter || !onSlideChange || total === 0) return
    const next = optimisticSlide + 1
    if (next < total) {
      setOptimisticSlide(next)
      onSlideChange(next, total)
    }
  }, [isPresenter, onSlideChange, optimisticSlide, total])

  const goPrev = useCallback(() => {
    if (!isPresenter || !onSlideChange || total === 0) return
    const prev = optimisticSlide - 1
    if (prev >= 0) {
      setOptimisticSlide(prev)
      onSlideChange(prev, total)
    }
  }, [isPresenter, onSlideChange, optimisticSlide, total])

  // Keyboard navigation for the presenter only.
  useEffect(() => {
    if (!isPresenter) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return
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
        ) : remoteStream && remoteStream.getTracks().length > 0 ? (
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

        {/* Slide counter — always shown. Arrows — presenter only. */}
        <div className="flex items-center gap-3">
          {isPresenter && (
            <button
              onClick={goPrev}
              disabled={!canGoBack}
              className={cn(
                "flex size-8 items-center justify-center rounded-full transition-colors",
                canGoBack ? "text-white hover:bg-white/15" : "cursor-default text-white/20",
              )}
              aria-label="Предыдущий слайд"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}

          <span className="min-w-[56px] text-center text-sm font-medium tabular-nums text-white/80">
            {total > 0 ? `${slide + 1} / ${total}` : "—"}
          </span>

          {isPresenter && (
            <button
              onClick={goNext}
              disabled={!canGoForward}
              className={cn(
                "flex size-8 items-center justify-center rounded-full transition-colors",
                canGoForward ? "text-white hover:bg-white/15" : "cursor-default text-white/20",
              )}
              aria-label="Следующий слайд"
            >
              <ChevronRight className="size-5" />
            </button>
          )}
        </div>

        {/* Spacer to keep arrows centred */}
        <div className="w-28" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PresenterCanvas
//
// Renders PDF pages (pdfjs-dist) or PPTX slides (pptx-preview + html2canvas-pro)
// into the offscreen canvas supplied by the parent (for captureStream) and into
// a local visible preview canvas so the presenter sees what they are sharing.
//
// Design decisions:
//  - All async loaders are wrapped in useCallback so they never form stale
//    closures over paintCanvas / renderPdfPage etc.
//  - A single AbortController guards the *load* lifecycle; a separate
//    renderAbortRef guards individual page renders (so navigating quickly
//    cancels the previous render without aborting the whole document).
//  - The PDF LoadingTask is stored in a ref so we can call destroy() on it
//    even before the promise resolves.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfLoadingTaskRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxPreviewerRef = useRef<any>(null)
  // Pre-rendered canvases for each PPTX slide (instant navigation).
  const pptxCanvasesRef = useRef<HTMLCanvasElement[]>([])

  const fileTypeRef = useRef<"pdf" | "pptx" | null>(null)
  const loadedRef = useRef(false)

  // Guards the whole file-load lifecycle.
  const loadAbortRef = useRef<AbortController | null>(null)
  // Guards individual PDF page renders so rapid navigation cancels the
  // previous render without touching the document.
  const renderAbortRef = useRef<AbortController | null>(null)

  // Stable ref to onLoaded so we never need it in effect dep arrays.
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  // -----------------------------------------------------------------------
  // paintCanvas — draw a source canvas into both the offscreen capture canvas
  // and the visible preview canvas.
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
  // renderPdfPage — render a single PDF page number (0-based) into canvas.
  // Uses its own AbortController so navigation can cancel a slow render.
  // -----------------------------------------------------------------------
  const renderPdfPage = useCallback(
    async (pageIndex: number, signal: AbortSignal) => {
      const pdf = pdfDocRef.current
      if (!pdf || signal.aborted) return
      try {
        const page = await pdf.getPage(pageIndex + 1)
        if (signal.aborted) return

        // Scale so the rendered width matches the 1280px capture canvas.
        // page.view = [x, y, width, height] in PDF user units.
        const naturalWidth: number = (page.view as number[])[2] ?? 612
        const scale = 1280 / naturalWidth
        const viewport = page.getViewport({ scale })
        const tmp = document.createElement("canvas")
        tmp.width = viewport.width
        tmp.height = viewport.height
        await page.render({ canvasContext: tmp.getContext("2d")!, viewport }).promise
        if (signal.aborted) return

        paintCanvas(tmp)
      } catch (err) {
        if (signal.aborted) return
        setError("Ошибка рендеринга страницы: " + (err instanceof Error ? err.message : String(err)))
      }
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // renderPptxSlide — paint a pre-rendered PPTX canvas (instant).
  // -----------------------------------------------------------------------
  const renderPptxSlide = useCallback(
    (index: number) => {
      const c = pptxCanvasesRef.current[index]
      if (c) paintCanvas(c)
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // loadPdf
  // -----------------------------------------------------------------------
  const loadPdf = useCallback(
    async (f: File, signal: AbortSignal) => {
      setLoadingMsg("Загрузка PDF…")
      setError(null)
      try {
        const pdfjsLib = await import("pdfjs-dist")
        if (signal.aborted) return

        // Use a static public path — Turbopack does not support
        // new URL("pkg/...", import.meta.url) for node_modules files.
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"

        const buf = await f.arrayBuffer()
        if (signal.aborted) return

        const loadingTask = pdfjsLib.getDocument({ data: buf })
        pdfLoadingTaskRef.current = loadingTask

        // If aborted before the task even started resolving, cancel it now.
        if (signal.aborted) {
          void loadingTask.destroy()
          pdfLoadingTaskRef.current = null
          return
        }

        // Destroy the task if aborted while the promise is in-flight.
        signal.addEventListener("abort", () => {
          void loadingTask.destroy()
          pdfLoadingTaskRef.current = null
        }, { once: true })

        const pdf = await loadingTask.promise
        if (signal.aborted) return

        pdfDocRef.current = pdf
        pdfLoadingTaskRef.current = null
        loadedRef.current = true
        setLoadingMsg(null)
        onLoadedRef.current(pdf.numPages)
        await renderPdfPage(0, signal)
      } catch (err) {
        if (signal.aborted) return
        setLoadingMsg(null)
        setError("Ошибка PDF: " + (err instanceof Error ? err.message : String(err)))
      }
    },
    [renderPdfPage],
  )

  // -----------------------------------------------------------------------
  // loadPptx
  //
  // Uses pptx-preview: init(dom, options) → PPTXPreviewer instance.
  //   previewer.load(ArrayBuffer)  → Promise<PPTX>
  //   previewer.slideCount         → number
  //   previewer.renderSingleSlide(i)
  //   previewer.destroy()
  //
  // Every slide is pre-rendered via html2canvas-pro so navigation is instant
  // and doesn't depend on DOM visibility tricks.
  // -----------------------------------------------------------------------
  const loadPptx = useCallback(
    async (f: File, signal: AbortSignal) => {
      setLoadingMsg("Загрузка PPTX…")
      setError(null)
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

        // Mount an invisible container so pptx-preview can render into the DOM.
        container = document.createElement("div")
        container.style.cssText =
          "position:fixed;left:-9999px;top:0;width:1280px;height:720px;" +
          "background:#fff;overflow:hidden;z-index:-1;"
        document.body.appendChild(container)

        // pptx-preview types declare number but the runtime renderer requires
        // CSS strings. Cast to avoid the TS mismatch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const previewer = pptxMod.init(container, { width: "1280px" as any, height: "720px" as any, mode: "slide" })
        pptxPreviewerRef.current = previewer

        await previewer.load(buf)
        if (signal.aborted) return

        const total: number = previewer.slideCount
        if (total === 0) throw new Error("Не найдено слайдов в файле")

        const canvases: HTMLCanvasElement[] = []

        for (let i = 0; i < total; i++) {
          if (signal.aborted) break
          setLoadingMsg(`Обработка слайда ${i + 1} / ${total}…`)
          previewer.renderSingleSlide(i)

          // Wait for the slide DOM to actually paint.
          // Two rAFs are not always enough for heavier slides — poll for
          // at least one child inside the container with a 300 ms deadline.
          await new Promise<void>((resolve) => {
            const deadline = Date.now() + 300
            const check = () => {
              if (container!.children.length > 0 || Date.now() >= deadline) {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              } else {
                requestAnimationFrame(check)
              }
            }
            requestAnimationFrame(check)
          })
          if (signal.aborted) break

          // scale: 1 — container is already 1280×720; scale:2 would produce
          // 2560×1440 canvases (×4 memory) for no visible benefit on a 1280px
          // capture canvas.
          const snap = await html2canvas(container, {
            useCORS: true,
            scale: 1,
            width: 1280,
            height: 720,
          })
          canvases.push(snap)
        }

        if (signal.aborted) return
        if (canvases.length === 0) throw new Error("Не удалось обработать слайды")

        pptxCanvasesRef.current = canvases
        loadedRef.current = true
        setLoadingMsg(null)
        // Report the number of canvases actually rendered, not previewer.slideCount,
        // so the slide counter is never ahead of what was processed.
        onLoadedRef.current(canvases.length)
        paintCanvas(canvases[0])
      } catch (err) {
        if (signal.aborted) return
        setLoadingMsg(null)
        setError("Ошибка PPTX: " + (err instanceof Error ? err.message : String(err)))
      } finally {
        // Always remove the container from DOM — even on error or abort.
        // Also destroy the previewer if it was created, to release memory.
        try {
          if (pptxPreviewerRef.current) {
            pptxPreviewerRef.current.destroy()
            pptxPreviewerRef.current = null
          }
        } catch { /* ignore */ }
        if (container && document.body.contains(container)) {
          document.body.removeChild(container)
        }
      }
    },
    [paintCanvas],
  )

  // -----------------------------------------------------------------------
  // Load file whenever it changes.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!file) return

    // Cancel the previous in-flight load.
    loadAbortRef.current?.abort()
    renderAbortRef.current?.abort()

    const abort = new AbortController()
    loadAbortRef.current = abort

    // Tear down previous documents.
    if (pdfLoadingTaskRef.current) {
      void pdfLoadingTaskRef.current.destroy()
      pdfLoadingTaskRef.current = null
    }
    pdfDocRef.current = null

    if (pptxPreviewerRef.current) {
      try { pptxPreviewerRef.current.destroy() } catch { /* ignore */ }
      pptxPreviewerRef.current = null
    }
    pptxCanvasesRef.current = []

    fileTypeRef.current = null
    loadedRef.current = false
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
  }, [file, loadPdf, loadPptx])

  // -----------------------------------------------------------------------
  // Re-render the correct slide whenever slideIndex changes (post-load).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!loadedRef.current) return

    // Cancel any in-flight page render before starting a new one.
    renderAbortRef.current?.abort()
    const abort = new AbortController()
    renderAbortRef.current = abort

    if (fileTypeRef.current === "pdf") {
      renderPdfPage(slideIndex, abort.signal)
    } else if (fileTypeRef.current === "pptx") {
      renderPptxSlide(slideIndex)
    }

    return () => { abort.abort() }
  }, [slideIndex, renderPdfPage, renderPptxSlide])

  // -----------------------------------------------------------------------
  // Cleanup on unmount
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      loadAbortRef.current?.abort()
      renderAbortRef.current?.abort()
      if (pdfLoadingTaskRef.current) {
        void pdfLoadingTaskRef.current.destroy()
      }
      if (pptxPreviewerRef.current) {
        try { pptxPreviewerRef.current.destroy() } catch { /* ignore */ }
      }
    }
  }, [])

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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl bg-black/70">
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
