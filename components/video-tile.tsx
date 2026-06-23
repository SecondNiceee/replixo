"use client"

import { useEffect, useRef, useState } from "react"
import { MicOff, User, Volume2, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSpeaking } from "@/hooks/use-speaking"
import { registerAudioElement, setStreamVolume } from "@/lib/audio-unlock"

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
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Per-user local audio controls (remote tiles only).
  const [localMuted, setLocalMuted] = useState(false)
  const [volume, setVolume] = useState(1)
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
    video.srcObject = stream
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
    const effective = localMuted ? 0 : volume
    const routed = setStreamVolume(audioStream, effective)
    const audio = audioRef.current
    if (audio) {
      if (routed) {
        audio.muted = true
      } else {
        audio.volume = volume
        audio.muted = localMuted
      }
    }
  }, [volume, localMuted, isLocal, audioStream])

  return (
    <div
      className={cn(
        "group relative flex items-center justify-center overflow-hidden rounded-2xl bg-black transition-all",
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

      {/* Remote audio — local audio is muted to prevent echo */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline className="hidden" />}

      {/* Per-user volume control (remote tiles only) */}
      {!isLocal && (
        <div
          className={cn(
            "absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/45 px-1.5 py-1 backdrop-blur-sm transition-opacity duration-200",
            isDragging ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <button
            onClick={() => setLocalMuted((m) => !m)}
            className="flex size-6 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
            aria-label={localMuted ? "Включить звук участника" : "Выключить звук участника"}
          >
            {localMuted || volume === 0 ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={localMuted ? 0 : volume}
            onChange={(e) => {
              const v = Number(e.target.value)
              setVolume(v)
              setLocalMuted(v === 0)
            }}
            onMouseDown={() => setIsDragging(true)}
            onMouseUp={() => setIsDragging(false)}
            onTouchStart={() => setIsDragging(true)}
            onTouchEnd={() => setIsDragging(false)}
            aria-label="Громкость участника"
            className={cn(
              "h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-white/30",
              // Webkit thumb — must be re-defined when using appearance-none,
              // otherwise the thumb has zero size and can't be grabbed/dragged.
              "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow",
              // Firefox thumb
              "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white",
            )}
          />
        </div>
      )}

      {/* Cam off placeholder */}
      {!isScreen && (isCamOff || !stream) && (
        <div className="absolute inset-0 flex items-center justify-center">
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
            ? `${displayName}${isLocal ? " (вы)" : ""} — экран`
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
