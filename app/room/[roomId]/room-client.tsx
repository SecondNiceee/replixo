"use client"

import { useRouter } from "next/navigation"
import { useState, useCallback, useRef, useEffect } from "react"
import dynamic from "next/dynamic"
import { EnableSoundBanner } from "@/components/enable-sound-banner"
import { useMediasoup } from "@/hooks/use-mediasoup"
import { useAudioDevices } from "@/hooks/use-audio-devices"
import { getDisplayName } from "@/lib/display-name"
import { RoomStatus } from "./room-status"
import { RoomHeader } from "./room-header"
import { RoomControls } from "./room-controls"
import { RoomVideoGrid } from "./room-video-grid"
import { RoomChat } from "./room-chat"
import { ChatFab } from "@/components/chat-fab"
import { useSettingsStore } from "@/lib/stores/chat-settings-store"
import { useSession } from "@/lib/auth-client"
import { PresenterCanvas } from "@/components/presentation-viewer"
import { playMessageSound } from "@/lib/sounds"
import { cn } from "@/lib/utils"

// tldraw is a heavy, browser-only dependency — load it lazily and skip SSR so
// it only ships/initialises when the board is actually opened.
const Whiteboard = dynamic(
  () => import("@/components/whiteboard").then((m) => m.Whiteboard),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Загрузка доски…
      </div>
    ),
  },
)

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
    readMarkers,
    markChatRead,
    whiteboardOpen,
    whiteboardSnapshot,
    openWhiteboard,
    closeWhiteboard,
    sendWhiteboardChange,
    sendWhiteboardSnapshot,
    subscribeWhiteboardChange,
  } = useMediasoup(roomId, displayName, create)

  const { devices: micDevices } = useAudioDevices()
  const [selectedMicLabel, setSelectedMicLabel] = useState<string | null>(null)
  const [controlsCollapsed, setControlsCollapsed] = useState(false)

  // Persisted chat-button settings (localStorage for guests, DB for accounts).
  // Hydrate once we know auth state; this also merges a guest's local draft into
  // the account on first authenticated load.
  const { data: authSession, isPending: authPending } = useSession()
  const hydrateSettings = useSettingsStore((s) => s.hydrate)
  const openChatKey = useSettingsStore((s) => s.settings.openChatKey)
  useEffect(() => {
    if (authPending) return
    hydrateSettings(!!authSession?.user)
  }, [authPending, authSession?.user, hydrateSettings])

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

  // Persist a read receipt to the server (and DB) whenever the chat panel is
  // open and the tab is visible. We mark up to the newest message's timestamp,
  // which broadcasts to peers so their messages flip to "read". Re-runs when new
  // messages arrive while the panel is open, and when the tab becomes visible.
  useEffect(() => {
    if (!chatOpen || messages.length === 0) return
    const markLatest = () => {
      if (document.hidden) return
      const last = messages[messages.length - 1]
      if (last) markChatRead(last.timestamp)
    }
    markLatest()
    document.addEventListener("visibilitychange", markLatest)
    return () => document.removeEventListener("visibilitychange", markLatest)
  }, [chatOpen, messages, markChatRead])

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

  // Configurable hotkey to toggle the chat panel (default: Tab). Ignored while
  // the user is typing in an input/textarea/contenteditable so it doesn't hijack
  // normal text entry (e.g. Tab navigation inside the chat composer).
  useEffect(() => {
    if (!openChatKey) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== openChatKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return
      }
      e.preventDefault()
      toggleChat()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openChatKey, toggleChat])

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

  const toggleWhiteboard = useCallback(() => {
    if (whiteboardOpen) {
      closeWhiteboard()
    } else {
      openWhiteboard()
    }
  }, [whiteboardOpen, closeWhiteboard, openWhiteboard])

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

      {whiteboardOpen ? (
        <div className="relative min-h-0 flex-1">
          <Whiteboard
            initialSnapshot={whiteboardSnapshot}
            onChange={sendWhiteboardChange}
            onSnapshot={sendWhiteboardSnapshot}
            subscribeRemote={subscribeWhiteboardChange}
          />
        </div>
      ) : (
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
      )}

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
        whiteboardOpen={whiteboardOpen}
        onToggleWhiteboard={toggleWhiteboard}
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
        readMarkers={readMarkers}
        peerIds={Array.from(peers.keys())}
      />

      {/* Floating, draggable chat button with a hover gear for settings. */}
      <ChatFab open={chatOpen} unreadCount={unreadCount} onToggleChat={toggleChat} />
    </div>
  )
}
