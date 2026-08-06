"use client"

import { useEffect, useRef, useState } from "react"
import { MicOff, User, Volume2, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSpeaking } from "@/hooks/use-speaking"
import { registerAudioElement, setStreamVolume } from "@/lib/audio-unlock"
import {
  StreamAnnotationCanvas,
  type AnnotationTool,
  type AnnotationStroke,
} from "@/components/stream-annotation-canvas"

// Annotation overlay config passed to a screen-share tile. When present (and the
// tile is a screen), a transparent drawing canvas is laid over the actual video
// content area so strokes (in normalized coords) line up for every participant.
export interface VideoTileAnnotation {
  active: boolean
  tool: AnnotationTool
  color: string
  penWidth: number
  onStroke: (stroke: AnnotationStroke) => void
  onClear: () => void
  subscribeRemoteStroke: (fn: (stroke: unknown) => void) => () => void
  subscribeRemoteClear: (fn: () => void) => () => void
  clearSignal: number
}

// Slider position that corresponds to the stream's natural loudness (gain 1.0).
// The slider runs 0..1; this is the default so users have headroom both down
// (quieter) and up (louder, up to 1/NORMAL_VOLUME ≈ 1.67x at 100%).
const NORMAL_VOLUME = 0.6

interface VideoTileProps {
  stream?: MediaStream
  audioStream?: MediaStream
  // For the local tile we don't get a separate audioStream, so the parent can
  // pass the local stream here purely for the speaking indicator.
  speakingStream?: MediaStream
  displayName: string
  isMuted?: boolean
  isCamOff?: boolean
  isLocal?: boolean
  // Screen share tiles render the video "contained" and never mirrored.
  isScreen?: boolean
  // Drawing overlay — only meaningful on screen-share tiles.
  annotation?: VideoTileAnnotation
  className?: string
}

export function VideoTile({
  stream,
  audioStream,
  speakingStream,
  displayName,
  isMuted = false,
  isCamOff = false,
  isLocal = false,
  isScreen = false,
  annotation,
  className,
}: VideoTileProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  // Pixel rect of the actually-displayed video content (object-contain leaves
  // letterbox bars). The annotation canvas is sized to this so normalized
  // coordinates map to the same screen pixels across every participant.
  const [videoBox, setVideoBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  // Per-user local audio controls (remote tiles only).
  // `volume` is the slider position in 0..1 (shown as 0%..100%). The default
  // sits at NORMAL_VOLUME (60%), which maps to the stream's natural loudness
  // (gain 1.0). Dragging below 60% makes the participant quieter; dragging
  // above 60% boosts them louder (up to ~1.67x at 100%).
  const [localMuted, setLocalMuted] = useState(false)
  const [volume, setVolume] = useState(NORMAL_VOLUME)
  const [isDragging, setIsDragging] = useState(false)

  // Analyse the relevant audio stream to drive the "speaking" ring.
  const analysedStream = isLocal ? speakingStream : audioStream
  const speaking = useSpeaking(analysedStream, !isMuted)

  // Compute up to two initials from the display name for the avatar.
  const initials = displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    // Electron/Chromium sometimes leaves a freshly-attached remote stream
    // paused (the `autoPlay` attribute doesn't always fire when srcObject is
    // set imperatively), which shows up as a black tile even though frames are
    // arriving. Kick playback explicitly, retrying briefly and again once the
    // metadata is ready. Video-only muted playback is always autoplay-allowed,
    // so this never prompts a gesture.
    let cancelled = false
    let tries = 0
    const play = () => {
      if (cancelled) return
      const p = video.play()
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          if (!cancelled && tries++ < 5) setTimeout(play, 300)
        })
      }
    }

    // Re-point the element at the stream and restart playback.
    //
    // The local tile is handed ONE long-lived MediaStream whose tracks are
    // swapped in place (camera recovery removes the dead capture track and adds
    // a fresh one). Because the MediaStream identity never changes, this effect
    // does not re-run and Chromium keeps rendering the element's original,
    // now-ended track — a permanently black self-view even though a live track
    // is sitting right there in `stream`. Re-assigning `srcObject` is what
    // forces the element to pick up the current track set.
    const attach = () => {
      if (cancelled) return
      // Assigning the same object is a no-op in some engines, so detach first.
      if (video.srcObject === stream) video.srcObject = null
      video.srcObject = stream
      tries = 0
      play()
    }

    video.srcObject = stream
    play()

    video.addEventListener("loadedmetadata", play)
    // `emptied` fires when the element loses its media — reattaching recovers it
    // instead of leaving a black frame behind.
    video.addEventListener("emptied", attach)
    // Track churn on the same MediaStream (camera recovery, screen-audio
    // replacement, a producer republishing after a reconnect).
    stream.addEventListener("addtrack", attach)
    stream.addEventListener("removetrack", attach)

    return () => {
      cancelled = true
      video.removeEventListener("loadedmetadata", play)
      video.removeEventListener("emptied", attach)
      stream.removeEventListener("addtrack", attach)
      stream.removeEventListener("removetrack", attach)
    }
  }, [stream])

  // Play remote audio through a dedicated <audio> element. Local audio is
  // never played back to avoid echo/feedback. Playback + autoplay-unlock is
  // handled centrally by the audio-unlock manager.
  // On iOS we also pass the raw MediaStream so the manager can route it
  // through an AudioContext (the only reliable path on mobile Safari).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioStream || isLocal) return
    audio.srcObject = audioStream
    const unregister = registerAudioElement(audio, audioStream)
    return unregister
  }, [audioStream, isLocal])

  // Apply per-user local mute / volume to the remote audio.
  // Remote audio is routed through an AudioContext gain node on every platform
  // (see audio-unlock), so the gain node is the authoritative volume control.
  // setStreamVolume returns true when the stream is routed through the context;
  // in that case the <audio> element must stay muted to avoid double playback.
  // If routing is unavailable (no AudioContext) we fall back to controlling the
  // element's own volume/muted directly.
  useEffect(() => {
    if (isLocal) return
    // Map the 0..1 slider position to a gain multiplier where NORMAL_VOLUME
    // (the default) == 1.0 (natural loudness). Below default → quieter,
    // above default → boosted.
    const gain = localMuted ? 0 : volume / NORMAL_VOLUME
    const routed = setStreamVolume(audioStream, gain)
    const audio = audioRef.current
    if (audio) {
      if (routed) {
        audio.muted = true
      } else {
        // HTMLMediaElement.volume only accepts 0..1, so boosting (>1) is only
        // possible on the AudioContext gain path above. Clamp the fallback.
        audio.volume = Math.max(0, Math.min(1, gain))
        audio.muted = localMuted
      }
    }
  }, [volume, localMuted, isLocal, audioStream])

  // Track the displayed video rectangle (accounting for object-contain
  // letterboxing) so the drawing canvas can overlay exactly the screen content.
  const annotationEnabled = isScreen && !!annotation
  useEffect(() => {
    if (!annotationEnabled) return
    const container = containerRef.current
    const video = videoRef.current
    if (!container || !video) return
    const compute = () => {
      const rect = container.getBoundingClientRect()
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) {
        setVideoBox({ left: 0, top: 0, width: rect.width, height: rect.height })
        return
      }
      const scale = Math.min(rect.width / vw, rect.height / vh)
      const dw = vw * scale
      const dh = vh * scale
      setVideoBox({
        left: (rect.width - dw) / 2,
        top: (rect.height - dh) / 2,
        width: dw,
        height: dh,
      })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(container)
    video.addEventListener("loadedmetadata", compute)
    video.addEventListener("resize", compute)
    return () => {
      ro.disconnect()
      video.removeEventListener("loadedmetadata", compute)
      video.removeEventListener("resize", compute)
    }
  }, [annotationEnabled])

  return (
    <div
      ref={containerRef}
      className={cn(
        "group relative flex items-center justify-center overflow-hidden rounded-2xl bg-black transition-all",
        // Subtle frame so participants are clearly separated on the dark
        // background. Slightly brighter on hover; the speaking outline (below)
        // sits on top via `outline` and is unaffected.
        "ring-1 ring-white/10 shadow-lg shadow-black/40 hover:ring-white/20",
        speaking && "outline outline-[3px] outline-offset-[2px] outline-green-500",
        className,
      )}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal || isMuted}
        className={cn(
          "h-full w-full",
          isScreen ? "object-contain" : "object-cover",
          (!isScreen && (isCamOff || !stream)) && "invisible",
          isScreen && !stream && "invisible",
          isLocal && !isScreen && "scale-x-[-1]",
        )}
      />

      {/* Annotation canvas — overlays exactly the displayed screen content so
          strokes line up for everyone. z-20 keeps it above the video but below
          the volume control (z-30) and bottom bar. */}
      {annotationEnabled && annotation && videoBox && (
        <div
          className="absolute z-20"
          style={{
            left: videoBox.left,
            top: videoBox.top,
            width: videoBox.width,
            height: videoBox.height,
          }}
        >
          <StreamAnnotationCanvas
            active={annotation.active}
            tool={annotation.tool}
            color={annotation.color}
            penWidth={annotation.penWidth}
            onStroke={annotation.onStroke}
            onClear={annotation.onClear}
            subscribeRemoteStroke={annotation.subscribeRemoteStroke}
            subscribeRemoteClear={annotation.subscribeRemoteClear}
            clearSignal={annotation.clearSignal}
          />
        </div>
      )}

      {/* Remote audio — local audio is muted to prevent echo */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline className="hidden" />}

      {/* Per-user volume control. Shown on any remote tile that actually
          carries audio — this covers both microphone tiles and screen-share
          tiles (their system audio arrives as `audioStream` here and is routed
          through the same per-stream gain node). Hidden when there's no audio
          to control so we never show a dead slider. */}
      {!isLocal && audioStream && (
        <div
          className={cn(
            // Bottom-right corner, vertically aligned with the name label in
            // the bottom bar (bottom-0 + py-4 → bottom-4). z-30 keeps it above
            // the bar.
            "absolute bottom-4 right-2 z-30 flex items-center gap-1.5 rounded-full bg-black/45 px-1.5 py-1 backdrop-blur-sm transition-opacity duration-200",
            // Appears only on hover/focus (or while actively dragging the slider).
            isDragging ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <button
            onClick={() => setLocalMuted((m) => !m)}
            className="flex size-6 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
            aria-label={
              localMuted
                ? isScreen
                  ? "Включить звук демонстрации"
                  : "Включить звук участника"
                : isScreen
                  ? "Выключить звук демонстрации"
                  : "Выключить звук участника"
            }
          >
            {localMuted || volume === 0 ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVolume(v)
              setLocalMuted(v === 0)
            }}
            onPointerDown={() => setIsDragging(true)}
            onPointerUp={() => setIsDragging(false)}
            onPointerCancel={() => setIsDragging(false)}
            aria-label={isScreen ? "Громкость демонстрации" : "Громкость участника"}
            className={cn(
              // The INPUT itself is tall (h-6 = 24px) so there's a comfortable
              // grab area for the mouse — a 6px track alone is nearly impossible
              // to click/drag. The visible thin bar is drawn via the track
              // pseudo-elements below; the input has a transparent background.
              "h-6 w-24 cursor-pointer touch-none appearance-none bg-transparent",
              // Webkit: thin visible track + grabbable thumb. The negative top
              // margin re-centers the 12px thumb on the 6px track.
              "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-white/30",
              "[&::-webkit-slider-thumb]:-mt-[3px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow",
              // Firefox: thin visible track + grabbable thumb.
              "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/30",
              "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white",
            )}
          />
          <span className="w-9 shrink-0 text-right text-[10px] font-semibold tabular-nums text-white/80">
            {`${Math.round(volume * 100)}%`}
          </span>
        </div>
      )}

      {/* Cam off placeholder — purely decorative, must NOT capture pointer
          events or it would cover the volume control (top-right) and block the
          slider, since it spans the whole tile and sits later in the DOM. */}
      {!isScreen && (isCamOff || !stream) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "flex items-center justify-center rounded-full bg-muted ring-1 ring-border/60 transition-all",
              "size-10 sm:size-14",
              speaking && "ring-2 ring-green-500",
            )}
          >
            {initials ? (
              <span className="text-sm font-semibold text-foreground sm:text-lg">{initials}</span>
            ) : (
              <User className="size-5 text-muted-foreground sm:size-6" />
            )}
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 px-4 py-4">
        <span className="max-w-[70%] truncate rounded-md bg-black/50 px-2.5 py-1 text-sm font-semibold leading-tight text-white backdrop-blur-sm shadow-sm">
          {isScreen
            ? `${displayName}${isLocal ? " (вы)" : ""} — эк��ан`
            : isLocal
              ? `${displayName} (вы)`
              : displayName}
        </span>
        <div className="flex items-center gap-1">
          {isMuted && (
            <span className="flex size-8 items-center justify-center rounded-full bg-destructive/90">
              <MicOff className="size-4 text-white" />
            </span>
          )}
          {!isLocal && localMuted && (
            <span className="flex size-5 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
              <VolumeX className="size-2.5 text-white" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
