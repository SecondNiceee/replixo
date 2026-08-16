"use client"

import { OverlayControls } from "@/components/overlay-controls"
import { AnnotationToolbar } from "@/components/annotation-toolbar"
import { StreamAnnotationCanvas, type AnnotationTool } from "@/components/stream-annotation-canvas"
import { OVERLAY_INTERACTIVE_ATTR } from "@/hooks/use-overlay-click-through"

interface RoomOverlayLayerProps {
  annotationActive: boolean
  annotationTool: AnnotationTool
  annotationColor: string
  annotationPenWidth: number
  annotationClearSignal: number
  onToolChange: (tool: AnnotationTool) => void
  onColorChange: (color: string) => void
  onPenWidthChange: (width: number) => void
  onCloseAnnotation: () => void
  onToggleAnnotation: () => void
  onClearAnnotation: () => void
  sendAnnotationStroke: (stroke: unknown) => void
  sendAnnotationClear: () => void
  subscribeAnnotationStroke: (fn: (stroke: unknown) => void) => () => void
  subscribeAnnotationClear: (fn: () => void) => () => void
  isMicMuted: boolean
  isCamOff: boolean
  /** Camera held down by the weak-network guard rather than by the user. */
  cameraSuppressed: boolean
  whiteboardOpen: boolean
  onToggleWhiteboard: () => void
  onToggleMic: () => void
  onToggleCam: () => void
  onStopScreenShare: () => void
  /**
   * Прямоугольник демонстрируемого источника в CSS-пикселях содержимого
   * overlay-окна. null (браузер / регион ещё не известен) — канвас на весь экран.
   */
  captureRegion?: CaptureRegion | null
}

/**
 * Electron overlay layer, shown while the local user shares a screen in the
 * desktop app. Renders a full-screen transparent annotation canvas (in the same
 * normalized coordinates as the on-tile canvas peers see), the drawing toolbar
 * and the compact overlay controls.
 *
 * Click-through: interactive wrappers are marked with OVERLAY_INTERACTIVE_ATTR
 * and pointer-events:none; the <canvas> only enables pointer-events while
 * drawing is active so clicks otherwise pass through to the desktop.
 */
export function RoomOverlayLayer({
  annotationActive,
  annotationTool,
  annotationColor,
  annotationPenWidth,
  annotationClearSignal,
  onToolChange,
  onColorChange,
  onPenWidthChange,
  onCloseAnnotation,
  onToggleAnnotation,
  onClearAnnotation,
  sendAnnotationStroke,
  sendAnnotationClear,
  subscribeAnnotationStroke,
  subscribeAnnotationClear,
  isMicMuted,
  isCamOff,
  cameraSuppressed,
  whiteboardOpen,
  onToggleWhiteboard,
  onToggleMic,
  onToggleCam,
  onStopScreenShare,
  captureRegion = null,
}: RoomOverlayLayerProps) {
  // Демонстрируется окно, занимающее часть экрана → канвас должен накрывать
  // ровно его, иначе нормализованные (0..1) координаты штрихов у зрителей
  // указывают в другое место. `degraded` = геометрию получить не удалось,
  // работаем как раньше (весь дисплей).
  const regionRect = captureRegion && !captureRegion.degraded ? captureRegion.rect : null
  // Свёрнутое/закрытое окно рисовать незачем: зрители всё равно видят стоп-кадр
  // или ничего, а штрихи ушли бы в координаты, которых на экране нет.
  const canvasHidden = Boolean(captureRegion && !captureRegion.visible)

  return (
    <>
      <div
        {...{ [OVERLAY_INTERACTIVE_ATTR]: "true" }}
        className="pointer-events-none fixed z-[9990]"
        style={
          regionRect
            ? {
                left: regionRect.left,
                top: regionRect.top,
                width: regionRect.width,
                height: regionRect.height,
                display: canvasHidden ? "none" : undefined,
              }
            : { inset: 0, display: canvasHidden ? "none" : undefined }
        }
      >
        <StreamAnnotationCanvas
          active={annotationActive}
          featherCursor
          tool={annotationTool}
          color={annotationColor}
          penWidth={annotationPenWidth}
          onStroke={sendAnnotationStroke}
          onClear={sendAnnotationClear}
          subscribeRemoteStroke={subscribeAnnotationStroke}
          subscribeRemoteClear={subscribeAnnotationClear}
          clearSignal={annotationClearSignal}
        />
      </div>

      {/* Тулбар рисования — над панелью контролов */}
      {annotationActive && (
        <div
          {...{ [OVERLAY_INTERACTIVE_ATTR]: "true" }}
          className="pointer-events-none fixed bottom-24 left-1/2 z-[9999] -translate-x-1/2"
        >
          <AnnotationToolbar
            tool={annotationTool}
            color={annotationColor}
            penWidth={annotationPenWidth}
            onToolChange={onToolChange}
            onColorChange={onColorChange}
            onPenWidthChange={onPenWidthChange}
            onClear={onClearAnnotation}
            onClose={onCloseAnnotation}
          />
        </div>
      )}

      <OverlayControls
        isMicMuted={isMicMuted}
        isCamOff={isCamOff}
        cameraSuppressed={cameraSuppressed}
        annotationActive={annotationActive}
        onToggleAnnotation={onToggleAnnotation}
        whiteboardOpen={whiteboardOpen}
        onToggleWhiteboard={onToggleWhiteboard}
        onToggleMic={onToggleMic}
        onToggleCam={onToggleCam}
        onStopScreenShare={onStopScreenShare}
      />
    </>
  )
}
