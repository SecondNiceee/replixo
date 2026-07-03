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
  onToggleMic: () => void
  onToggleCam: () => void
  onStopScreenShare: () => void
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
  onToggleMic,
  onToggleCam,
  onStopScreenShare,
}: RoomOverlayLayerProps) {
  return (
    <>
      <div
        {...{ [OVERLAY_INTERACTIVE_ATTR]: "true" }}
        className="pointer-events-none fixed inset-0 z-[9990]"
      >
        <StreamAnnotationCanvas
          active={annotationActive}
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
        annotationActive={annotationActive}
        onToggleAnnotation={onToggleAnnotation}
        onToggleMic={onToggleMic}
        onToggleCam={onToggleCam}
        onStopScreenShare={onStopScreenShare}
      />
    </>
  )
}
