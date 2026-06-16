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
import { RoomChat } from "./room-chat"
import { PresenterCanvas } from "@/components/presentation-viewer"
import { playMessageSound } from "@/lib/sounds"
import { cn } from "@/lib/utils"

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
    messages,
    sendChatMessage,
  } = useMediasoup(roomId, displayName, create)

  const { devices: micDevices } = useAudioDevices()
  const [selectedMicLabel, setSelectedMicLabel] = useState<string | null>(null)
  const [controlsCollapsed, setControlsCollapsed] = useState(false)

  // Chat panel open state + unread counter. We track how many messages had been
  // seen the last time the panel was open; anything beyond that is "unread".
  const [chatOpen, setChatOpen] = useState(false)
  const [seenCount, setSeenCount] = useState(0)
  // Index of the first unread message captured at the moment the panel opens.
  // Messages from this index onward get a subtle highlight inside the chat so
  // it's easy to spot what arrived while you were away. null = nothing unread.
  const [unreadFromIndex, setUnreadFromIndex] = useState<number | null>(null)
  const unreadCount = chatOpen ? 0 : Math.max(0, messages.length - seenCount)

  // While the chat is open, keep marking everything as seen so the badge stays
  // cleared as new messages stream in.
  useEffect(() => {
    if (chatOpen) setSeenCount(messages.length)
  }, [chatOpen, messages.length])

  // Play a gentle chime for incoming messages when the user can't see them —
  // i.e. the chat panel is closed OR the browser tab is in the background.
  const prevMsgLenRef = useRef(messages.length)
  useEffect(() => {
    const prev = prevMsgLenRef.current
    if (messages.length > prev) {
      const arrived = messages.slice(prev)
      const hasIncoming = arrived.some((m) => !m.self)
      if (hasIncoming && (!chatOpen || document.hidden)) {
        playMessageSound()
      }
    }
    prevMsgLenRef.current = messages.length
  }, [messages, chatOpen])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      const next = !open
      if (next) {
        // Freeze the unread boundary so we can highlight what was missed.
        setUnreadFromIndex(seenCount < messages.length ? seenCount : null)
        setSeenCount(messages.length)
      }
      return next
    })
  }, [messages.length, seenCount])

  const closeChat = useCallback(() => setChatOpen(false), [])

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
    <div className="relative flex h-screen flex-col overflow-hidden bg-background">
      {/* Offscreen canvas for presentation capture */}
      <canvas
        ref={presentationCanvasRef}
        className="pointer-events-none fixed left-[-9999px] top-0"
        width={1280}
        height={720}
        aria-hidden
      />
      {/* PresenterCanvas is mounted as soon as a file is selected so it can
          render slide 0 into the offscreen canvas and call onLoaded — which
          triggers startPresentation(). Without this, isPresenting stays false
          and PresentationViewer never mounts, so onLoaded never fires. */}
      {presentationFile && !isPresenting && (
        <div className="pointer-events-none fixed left-[-9999px] top-0" aria-hidden>
          <PresenterCanvas
            canvasRef={presentationCanvasRef}
            file={presentationFile}
            slideIndex={0}
            onLoaded={handlePresentationLoaded}
          />
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.pptx"
        className="hidden"
        onChange={handleFileSelected}
        aria-label="Выбрать файл презентации"
      />

      <EnableSoundBanner />

      {/* Main column. When the chat opens on >=sm screens we add a right margin
          so the content visibly shrinks beside the panel instead of being
          covered by it. On mobile the chat overlays full-width as before. */}
      <div
        className={cn(
          "flex h-full min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-300 ease-in-out",
          chatOpen && "sm:mr-[360px]",
        )}
      >
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

      {/* Overflow wrapper: clips the footer when it slides down, and provides
          the anchor point for the toggle handle that peeks above it */}
      <div className="relative shrink-0 overflow-visible">
      <RoomControls
        isMicMuted={isMicMuted}
        isCamOff={isCamOff}
        isScreenSharing={isScreenSharing}
        isPresenting={isPresenting}
        screenQuality={screenQuality}
        micDevices={micDevices}
        selectedMicLabel={selectedMicLabel}
        collapsed={controlsCollapsed}
        chatOpen={chatOpen}
        unreadCount={unreadCount}
        onToggleChat={toggleChat}
        onToggleCollapsed={() => setControlsCollapsed((v) => !v)}
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
      </div>

      <RoomChat
        open={chatOpen}
        onClose={closeChat}
        messages={messages}
        onSend={sendChatMessage}
        unreadFromIndex={unreadFromIndex}
      />
    </div>
  )
}
