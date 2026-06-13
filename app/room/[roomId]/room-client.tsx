"use client"

import { useRouter } from "next/navigation"
import { useState, useCallback, useRef, useEffect } from "react"
import { EnableSoundBanner } from "@/components/enable-sound-banner"
import { useMediasoup } from "@/hooks/use-mediasoup"
import { useAudioDevices } from "@/hooks/use-audio-devices"
import { getDisplayName } from "@/lib/display-name"
import { RoomStatus } from "./room-status"
import { RoomHeader } from "./room-header"
import { RoomControls } from "./room-controls"
import { RoomVideoGrid } from "./room-video-grid"

interface RoomClientProps {
  roomId: string
  create: boolean
}

export default function RoomClient({ roomId, create }: RoomClientProps) {
  const router = useRouter()
  const displayName = getDisplayName()

  const {
    status,
    error,
    peers,
    localStream,
    isMicMuted,
    isCamOff,
    isScreenSharing,
    localScreenStream,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    screenQuality,
    setScreenQuality,
    switchMic,
    leave,
    isPresenting,
    startPresentation,
    stopPresentation,
    notifySlideChange,
    currentSlide,
  } = useMediasoup(roomId, displayName, create)

  const { devices: micDevices } = useAudioDevices()
  const [selectedMicLabel, setSelectedMicLabel] = useState<string | null>(null)

  // Presentation
  const presentationCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [presentationFile, setPresentationFile] = useState<File | null>(null)

  // Sync presentationFile with isPresenting — if remote stopped it, clear locally
  const wasPresentingRef = useRef(false)
  useEffect(() => {
    if (wasPresentingRef.current && !isPresenting) {
      setPresentationFile(null)
    }
    wasPresentingRef.current = isPresenting
  }, [isPresenting])

  // Whether we've already called startPresentation for the current file.
  // Guards against onLoaded firing multiple times (e.g. from React Strict Mode).
  const presentationStartedRef = useRef(false)

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ""
      presentationStartedRef.current = false
      // Just set the file — PresenterCanvas will render the first slide into the
      // offscreen canvas, then call onLoaded. We start the stream capture there
      // so the first frame is already painted before viewers receive it.
      setPresentationFile(file)
    },
    [],
  )

  // Called by PresenterCanvas once the first slide is painted into the canvas.
  const handlePresentationLoaded = useCallback(
    async (total: number) => {
      if (presentationStartedRef.current) return
      presentationStartedRef.current = true
      const canvas = presentationCanvasRef.current
      if (!canvas) return
      try {
        const stream = canvas.captureStream(30)
        await startPresentation(stream)
        // notifySlideChange so all peers get slide 0 / total immediately.
        notifySlideChange(0, total)
      } catch (err) {
        console.error("[Replixo] startPresentation failed:", err)
        setPresentationFile(null)
        presentationStartedRef.current = false
      }
    },
    [startPresentation, notifySlideChange],
  )

  const handleStopPresentation = useCallback(() => {
    stopPresentation()
    setPresentationFile(null)
  }, [stopPresentation])

  const handlePresentationAction = useCallback(() => {
    if (isPresenting) {
      handleStopPresentation()
    } else {
      fileInputRef.current?.click()
    }
  }, [isPresenting, handleStopPresentation])

  const handleLeave = useCallback(() => {
    leave()
    router.push("/")
  }, [leave, router])

  // Non-connected states
  if (status !== "connected") {
    return <RoomStatus status={status} error={error} roomId={roomId} />
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Offscreen canvas for presentation capture */}
      <canvas
        ref={presentationCanvasRef}
        className="pointer-events-none fixed left-[-9999px] top-0"
        width={1280}
        height={720}
        aria-hidden
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.pptx"
        className="hidden"
        onChange={handleFileSelected}
        aria-label="Выбрать файл презентации"
      />

      <EnableSoundBanner />

      <RoomHeader
        roomId={roomId}
        displayName={displayName}
        status={status}
        participantCount={peers.size + 1}
      />

      <RoomVideoGrid
        localStream={localStream}
        localScreenStream={localScreenStream}
        displayName={displayName}
        isMicMuted={isMicMuted}
        isCamOff={isCamOff}
        isScreenSharing={isScreenSharing}
        isPresenting={isPresenting}
        peers={peers}
        currentSlide={currentSlide}
        presentationFile={presentationFile}
        presentationCanvasRef={presentationCanvasRef}
        onSlideChange={notifySlideChange}
        onPresentationLoaded={handlePresentationLoaded}
        onStopPresentation={handleStopPresentation}
      />

      <RoomControls
        isMicMuted={isMicMuted}
        isCamOff={isCamOff}
        isScreenSharing={isScreenSharing}
        isPresenting={isPresenting}
        screenQuality={screenQuality}
        micDevices={micDevices}
        selectedMicLabel={selectedMicLabel}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
        onToggleScreenShare={toggleScreenShare}
        onSetScreenQuality={setScreenQuality}
        onSwitchMic={switchMic}
        onSelectMicLabel={setSelectedMicLabel}
        onPresentationAction={handlePresentationAction}
        onLeave={handleLeave}
      />
    </div>
  )
}
