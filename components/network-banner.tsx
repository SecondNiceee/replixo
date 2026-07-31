"use client"

import { useEffect, useRef, useState } from "react"
import { SignalLow, VideoOff, Video, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { VideoMode } from "@/hooks/mediasoup/use-network-guard"

interface NetworkBannerProps {
  /** Our camera was turned off by the guard, not by the user. */
  uplinkVideoSuppressed: boolean
  /** Incoming camera video was turned off because our downlink is failing. */
  downlinkVideoSuppressed: boolean
  /** Video still flows, just pinned to the smallest/choppiest layer. */
  videoDegraded: boolean
  videoMode: VideoMode
  setVideoMode: (mode: VideoMode) => void
}

/**
 * Explains, in the call itself, why the picture just changed.
 *
 * Without this the guard is indistinguishable from a bug: the camera goes dark
 * on its own and the user has no idea the call deliberately traded video away
 * to keep the voice intelligible. Deliberately a non-blocking banner rather than
 * a dialog — a modal over a live call would hide the person you are talking to
 * and demand a click at the exact moment the connection is already struggling.
 */
export function NetworkBanner({
  uplinkVideoSuppressed,
  downlinkVideoSuppressed,
  videoDegraded,
  videoMode,
  setVideoMode,
}: NetworkBannerProps) {
  const suppressed = uplinkVideoSuppressed || downlinkVideoSuppressed
  const [dismissed, setDismissed] = useState(false)

  // A dismissal applies to the episode the user dismissed, not forever: once the
  // network recovers the banner re-arms so the next drop is explained too.
  const wasActiveRef = useRef(false)
  const active = suppressed || videoDegraded
  useEffect(() => {
    if (wasActiveRef.current && !active) setDismissed(false)
    wasActiveRef.current = active
  }, [active])

  // The "quality reduced" notice is informational, so it retreats on its own.
  // The "video is off" notice stays put, because it comes with an action.
  useEffect(() => {
    if (!videoDegraded || suppressed) return
    const timer = setTimeout(() => setDismissed(true), 6000)
    return () => clearTimeout(timer)
  }, [videoDegraded, suppressed])

  if (videoMode === "force-video" || !active || dismissed) return null

  const message = suppressed
    ? uplinkVideoSuppressed && downlinkVideoSuppressed
      ? "Слабая сеть: видео отключено с обеих сторон, звук работает"
      : uplinkVideoSuppressed
        ? "Слабая сеть: ваша камера отключена, вас продолжают слышать"
        : "Слабая сеть: видео собеседников отключено, звук работает"
    : "Слабая сеть: качество видео снижено, чтобы не пропадал звук"

  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-auto flex max-w-[min(100%,34rem)] items-center gap-3",
          "rounded-full border border-border bg-card/95 py-2 pl-4 pr-2 shadow-lg backdrop-blur",
        )}
      >
        {suppressed ? (
          <VideoOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <SignalLow className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}

        <p className="text-pretty text-sm leading-relaxed text-foreground">{message}</p>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {suppressed && (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5 rounded-full"
              onClick={() => setVideoMode("force-video")}
            >
              <Video className="size-3.5" aria-hidden="true" />
              Включить
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-8 rounded-full text-muted-foreground"
            onClick={() => setDismissed(true)}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Скрыть уведомление</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
