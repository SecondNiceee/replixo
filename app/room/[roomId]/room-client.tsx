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
import { FloatingChatButton } from "./floating-chat-button"
import { OverlayControls } from "@/components/overlay-controls"
import { ChevronRight } from "lucide-react"
import { playMessageSound } from "@/lib/sounds"
import { cn } from "@/lib/utils"
import { useChatButtonStore } from "@/stores/chat-button-store"
import { useOverlayMouseManager } from "@/hooks/use-overlay-click-through"

import dynamic from "next/dynamic"

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
    permissionError,
    clearPermissionError,
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
  const [participantsHidden, setParticipantsHidden] = useState(false)

  // Electron overlay-режим: активируется когда мы сами демонстрируем экран.
  // Окно становится прозрачным и всегда поверх — видим только сайдбар + контролы.
  const isElectron = typeof window !== "undefined" && !!window.electronAPI?.isElectron
  const [overlayMode, setOverlayMode] = useState(false)

  useEffect(() => {
    if (!isElectron) return
    if (isScreenSharing) {
      // Сначала делаем документ прозрачным (data-overlay), затем растягиваем
      // окно поверх экрана — чтобы не мелькнул непрозрачный фон.
      document.documentElement.dataset.overlay = "1"
      window.electronAPI!.enterOverlayMode()
      setOverlayMode(true)
    } else {
      window.electronAPI!.exitOverlayMode()
      delete document.documentElement.dataset.overlay
      setOverlayMode(false)
    }
    return () => {
      // Подстраховка при размонтировании (например, выход из комнаты во время показа)
      delete document.documentElement.dataset.overlay
    }
  }, [isScreenSharing, isElectron])

  // Глобальный менеджер click-through: пока активен overlay, клики проходят на
  // рабочий стол, кроме интерактивных областей (контролы, сайдбар участников).
  useOverlayMouseManager(overlayMode)

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

  // Global hotkey to toggle the chat. The bound key (KeyboardEvent.code) lives
  // in the persisted chat-button store and can be rebound from its settings.
  // We ignore presses while typing in inputs/textareas/contenteditable so the
  // shortcut never hijacks normal text entry (e.g. the chat composer itself).
  const chatHotkey = useChatButtonStore((s) => s.hotkey)
  useEffect(() => {
    if (!chatHotkey) return
    const handler = (e: KeyboardEvent) => {
      if (e.code !== chatHotkey) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Only skip the hotkey for keys that actually type a character (e.key
      // of length 1, e.g. letters/digits) while focused in a text field, so
      // we never hijack normal text entry in the chat composer. Non-text keys
      // like Tab/Escape/F-keys (e.key.length > 1) must still toggle the chat
      // even when the composer is focused — otherwise it could never be closed.
      const isTypingKey = e.key.length === 1
      if (isTypingKey) {
        const t = e.target as HTMLElement | null
        if (
          t &&
          (t.isContentEditable ||
            t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT")
        ) {
          return
        }
      }
      e.preventDefault()
      toggleChat()
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [chatHotkey, toggleChat])

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
    <div className={cn(
      "relative flex flex-col overflow-hidden",
      // В Electron (без overlay) резервируем 32px под кастомный титлбар.
      isElectron && !overlayMode ? "h-[calc(100vh-32px)]" : "h-screen",
      overlayMode ? "bg-transparent" : "bg-background",
    )}>
      {!overlayMode && <EnableSoundBanner />}

      {/* Permission error banner — shown when the browser blocked mic or cam access */}
      {permissionError && (
        <div className="relative z-50 flex items-center justify-between gap-3 bg-destructive/10 px-4 py-2 text-sm text-destructive border-b border-destructive/20">
          <span>
            {permissionError === "mic"
              ? "Нет доступа к микрофону. Разрешите его в настройках браузера (возможно, вы нажали «Запретить» при запросе разрешения)"
              : "Нет доступа к камере. Разрешите его в настройках браузера (возможно, вы нажали «Запретить» при запросе разрешения)"}
          </span>
          <button
            onClick={clearPermissionError}
            aria-label="Закрыть"
            className="shrink-0 text-destructive/70 hover:text-destructive transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main column. When the chat opens on >=sm screens we add a right margin
          so the content visibly shrinks beside the panel instead of being
          covered by it. On mobile the chat overlays full-width as before. */}
      {!overlayMode && (
        <RoomHeader
          roomId={roomId}
          displayName={displayName}
          status={status}
          participantCount={peers.size + 1}
          isFixed={isScreenSharing || [...peers.values()].some((p) => p.screenStream != null)}
          chatOpen={chatOpen}
          participantsOpen={!participantsHidden && (isScreenSharing || [...peers.values()].some((p) => p.screenStream != null))}
        />
      )}

      <div
        className={cn(
          "flex h-full min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-300 ease-in-out",
          chatOpen && "sm:mr-[360px]",
        )}
      >

      {/* The video grid stays MOUNTED even while the whiteboard is open — it
          hosts the participants' <audio> elements, so unmounting it (a ternary
          swap) would cut everyone's audio. Instead we hide it behind the board
          with `hidden` (display:none keeps media playing) and overlay the
          whiteboard on top. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 flex-1 flex-col", whiteboardOpen && "hidden")}>
          <RoomVideoGrid
            localStream={localStream}
            localScreenStream={localScreenStream}
            displayName={displayName}
            isMicMuted={isMicMuted}
            isCamOff={isCamOff}
            isScreenSharing={isScreenSharing}
            peers={peers}
            participantsHidden={participantsHidden}
            onParticipantsHiddenChange={setParticipantsHidden}
            overlayMode={overlayMode}
          />
        </div>
        {whiteboardOpen && (
          <div className="absolute inset-0">
            <Whiteboard
              initialSnapshot={whiteboardSnapshot}
              onChange={sendWhiteboardChange}
              onSnapshot={sendWhiteboardSnapshot}
              subscribeRemote={subscribeWhiteboardChange}
            />
          </div>
        )}
      </div>

      {/* Overflow wrapper: clips the footer when it slides down, and provides
          the anchor point for the toggle handle that peeks above it */}
      {!overlayMode && (
        <div className="relative shrink-0 overflow-visible">
          <RoomControls
            isMicMuted={isMicMuted}
            isCamOff={isCamOff}
            isScreenSharing={isScreenSharing}
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
            onLeave={handleLeave}
          />
        </div>
      )}
      </div>

      {/* Chat panel — slides in from the right. A sticky arrow tab peeks out
          from the left edge of the panel, matching the participants panel handle
          pattern used in the screen-share layout. */}
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-30 flex transition-transform duration-300 ease-in-out",
          chatOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Arrow handle — sits on the left edge, always visible */}
        <button
          onClick={toggleChat}
          aria-label={chatOpen ? "Скрыть чат" : "Открыть чат"}
          className="absolute -left-7 top-1/2 z-10 flex h-14 w-7 -translate-y-1/2 items-center justify-center rounded-l-xl border border-r-0 border-border bg-background/90 backdrop-blur-sm transition-colors hover:bg-accent"
        >
          <ChevronRight
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-300",
              chatOpen ? "rotate-0" : "rotate-180",
            )}
          />
        </button>

        <RoomChat
          open={chatOpen}
          onClose={closeChat}
          messages={messages}
          onSend={sendChatMessage}
          unreadFromIndex={unreadFromIndex}
          readMarkers={readMarkers}
          peerIds={Array.from(peers.keys())}
        />
      </div>

      {!overlayMode && (
        <FloatingChatButton
          chatOpen={chatOpen}
          unreadCount={unreadCount}
          onToggleChat={toggleChat}
        />
      )}

      {/* Overlay controls: плавающая панель снизу в режиме демонстрации экрана */}
      {overlayMode && (
        <OverlayControls
          isMicMuted={isMicMuted}
          isCamOff={isCamOff}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onStopScreenShare={toggleScreenShare}
        />
      )}
    </div>
  )
}
