"use client"

import { useRouter } from "next/navigation"
import { useState, useCallback, useEffect } from "react"
import { EnableSoundBanner } from "@/components/enable-sound-banner"
import { NetworkBanner } from "@/components/network-banner"
import { useMediasoup } from "@/hooks/use-mediasoup"
import { useAudioDevices } from "@/hooks/use-audio-devices"
import { getSavedDisplayName, setDisplayName } from "@/lib/display-name"
import { RoomStatus } from "./room-status"
import { RoomHeader } from "./room-header"
import { RoomControls } from "./room-controls"
import { RoomVideoGrid } from "./room-video-grid"
import { RoomChat } from "./room-chat"
import { FloatingChatButton } from "./floating-chat-button"
import { AnnotationToolbar } from "@/components/annotation-toolbar"
import { RoomOverlayLayer } from "./room-overlay-layer"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { OVERLAY_INTERACTIVE_ATTR } from "@/hooks/use-overlay-click-through"
import { useChatPanel } from "./use-chat-panel"
import { useAnnotationOverlay } from "./use-annotation-overlay"
import { RoomSettingsDialog, type Tab as SettingsTab } from "./room-settings-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

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
  serverDisplayName: string | null
}

export default function RoomClient({ roomId, create, serverDisplayName }: RoomClientProps) {
  const [displayName, setResolvedDisplayName] = useState<string | null>(serverDisplayName)
  const [nameInput, setNameInput] = useState("")
  const [storageChecked, setStorageChecked] = useState(serverDisplayName !== null)

  useEffect(() => {
    if (serverDisplayName) return
    setResolvedDisplayName(getSavedDisplayName())
    setStorageChecked(true)
  }, [serverDisplayName])

  const handleNameSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    setDisplayName(name)
    setResolvedDisplayName(name)
  }

  if (!storageChecked) {
    return <RoomStatus status="idle" error={null} roomId={roomId} />
  }

  if (!displayName) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <Dialog open>
          <DialogContent showCloseButton={false} className="sm:max-w-sm">
            <form onSubmit={handleNameSubmit} className="flex flex-col gap-6">
              <DialogHeader>
                <DialogTitle>Как вас представить?</DialogTitle>
                <DialogDescription>
                  Введите имя, которое увидят другие участники комнаты.
                </DialogDescription>
              </DialogHeader>
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="room-display-name">
                Ваше имя
                <Input
                  id="room-display-name"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                      event.preventDefault()
                    }
                  }}
                  placeholder="Введите имя"
                  maxLength={32}
                  autoFocus
                  autoComplete="nickname"
                  required
                />
              </label>
              <DialogFooter>
                <Button type="submit" disabled={!nameInput.trim()} className="w-full">
                  Войти в комнату
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </main>
    )
  }

  return <ConnectedRoomClient roomId={roomId} create={create} displayName={displayName} />
}

function ConnectedRoomClient({ roomId, create, displayName }: Omit<RoomClientProps, "serverDisplayName"> & { displayName: string }) {
  const router = useRouter()

  const {
    status,
    error,
    permissionError,
    clearPermissionError,
    peers,
    localStream,
    isMicMuted,
    isCamOff,
    isCamStarting,
    activeMicId,
    isMicSwitching,
    isScreenSharing,
    localScreenStream,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    stopScreenShare,
    screenQuality,
    setScreenQuality,
    switchMic,
    leave,
    messages,
    sendChatMessage,
    uploadChatFile,
    mediaBaseUrl,
    readMarkers,
    markChatRead,
    whiteboardOpen,
    whiteboardSnapshot,
    openWhiteboard,
    closeWhiteboard,
    sendWhiteboardChange,
    sendWhiteboardSnapshot,
    subscribeWhiteboardChange,
    sendAnnotationStroke,
    sendAnnotationClear,
    subscribeAnnotationStroke,
    subscribeAnnotationClear,
    videoMode,
    setVideoMode,
    videoDegraded,
    uplinkVideoSuppressed,
    downlinkVideoSuppressed,
    noteUserWantsVideo,
  } = useMediasoup(roomId, displayName, create)

  const { devices: micDevices } = useAudioDevices()
  const [controlsCollapsed, setControlsCollapsed] = useState(false)
  const [participantsHidden, setParticipantsHidden] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("mic")

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

  // Annotation (drawing over the shared screen) + Electron overlay lifecycle.
  const {
    canAnnotate,
    annotationActive,
    annotationTool,
    annotationColor,
    annotationPenWidth,
    annotationClearSignal,
    setAnnotationTool,
    setAnnotationColor,
    setAnnotationPenWidth,
    setAnnotationActive,
    toggleAnnotation,
    triggerAnnotationClear,
    isElectron,
    overlayMode,
  } = useAnnotationOverlay({ isScreenSharing, peers })

  // Chat panel state: open/close, unread counter, read receipts, chime, hotkey.
  const { chatOpen, unreadCount, unreadFromIndex, toggleChat, closeChat } = useChatPanel({
    messages,
    markChatRead,
  })

  // Перо включается/выключается сразу, без подсказки о двойном нажатии.
  const handleAnnotationButtonClick = toggleAnnotation

  const openSettings = useCallback((tab: SettingsTab = "mic") => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])

  const toggleWhiteboard = useCallback(() => {
    if (whiteboardOpen) {
      closeWhiteboard()
    } else {
      // В Electron annotation-canvas находится поверх всего окна и иначе
      // перехватывает указатель у tldraw. Доска и аннотации — взаимоисключающие
      // полноэкранные режимы ввода.
      setAnnotationActive(false)
      openWhiteboard()
    }
  }, [whiteboardOpen, closeWhiteboard, openWhiteboard, setAnnotationActive])

  // Pressing the camera button while the guard is holding video down has to mean
  // "give me my camera back", not "toggle". The camera track still exists in that
  // state (it is only paused and disabled), so a plain toggleCam would take the
  // "camera is on, turn it off" branch and close the producer for real — the user
  // would end up permanently off-camera by trying to come back on.
  const handleToggleCam = useCallback(() => {
    if (uplinkVideoSuppressed && !isCamOff) {
      noteUserWantsVideo()
      return
    }
    void toggleCam()
  }, [uplinkVideoSuppressed, isCamOff, noteUserWantsVideo, toggleCam])

  const handleLeave = useCallback(() => {
    leave()
    router.push("/")
  }, [leave, router])

  // Non-connected states
  if (status !== "connected") {
    return <RoomStatus status={status} error={error} roomId={roomId} />
  }

  const anyScreenShared = isScreenSharing || [...peers.values()].some((p) => p.screenStream != null)

  return (
    <div className={cn(
      "relative flex select-none flex-col overflow-hidden",
      // В Electron (без overlay) резервируем 32px под кастомный титлбар.
      isElectron && !overlayMode ? "h-[calc(100vh-32px)]" : "h-screen",
      overlayMode ? "bg-transparent" : "bg-background",
    )}>
      {!overlayMode && <EnableSoundBanner />}

      {/* Explains why video shrank or disappeared on a weak connection. */}
      {!overlayMode && (
        <NetworkBanner
          uplinkVideoSuppressed={uplinkVideoSuppressed}
          downlinkVideoSuppressed={downlinkVideoSuppressed}
          videoDegraded={videoDegraded}
          videoMode={videoMode}
          setVideoMode={setVideoMode}
        />
      )}

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
          isFixed={anyScreenShared}
          chatOpen={chatOpen}
          participantsOpen={!participantsHidden && anyScreenShared}
          onOpenSettings={() => openSettings("mic")}
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
          swap) would cut everyone's audio. While the board is open the grid
          switches to a compact "participants only" column on the left (exactly
          like the screen-share layout) and the board takes the rest of the
          space, so people + chat stay reachable via their arrow handles. */}
      <div
        className={cn(
          "relative flex min-h-0 flex-1",
          whiteboardOpen ? "flex-col lg:flex-row" : "flex-col",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0",
            whiteboardOpen ? "shrink-0" : "flex-1 flex-col",
          )}
        >
          {/* `isCamOff` here also covers a guard-paused camera: the track is
              still live, so without it the self-view would be a black rectangle
              instead of the usual avatar placeholder. */}
          <RoomVideoGrid
            localStream={localStream}
            localScreenStream={localScreenStream}
            displayName={displayName}
            isMicMuted={isMicMuted}
            isCamOff={isCamOff || uplinkVideoSuppressed}
            isScreenSharing={isScreenSharing}
            peers={peers}
            participantsHidden={participantsHidden}
            onParticipantsHiddenChange={setParticipantsHidden}
            overlayMode={overlayMode}
            whiteboardOpen={whiteboardOpen && !overlayMode}
            annotation={{
              active: annotationActive,
              tool: annotationTool,
              color: annotationColor,
              penWidth: annotationPenWidth,
              onStroke: sendAnnotationStroke,
              onClear: sendAnnotationClear,
              subscribeRemoteStroke: subscribeAnnotationStroke,
              subscribeRemoteClear: subscribeAnnotationClear,
              clearSignal: annotationClearSignal,
            }}
          />
        </div>
        {whiteboardOpen && (
          <div
            {...{ [OVERLAY_INTERACTIVE_ATTR]: "true" }}
            className={cn(
              "pointer-events-auto",
              overlayMode
                // Overlay (Electron, идёт демонстрация): доска растянута на всё
                // прозрачное окно, поверх видеослоя, но ниже overlay-контролов
                // (z-9990+). Сайдбар участников — fixed слева, поэтому
                // отступаем, чтобы он не накрывал доску.
                ? cn("absolute inset-0 z-[9980]", !participantsHidden && "lg:left-52")
                // Обычное окно: доска — сосед колонки участников по flex-строке.
                : "relative min-h-0 min-w-0 flex-1",
            )}
          >
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
            localStream={localStream}
            isCamOff={isCamOff}
            isCamStarting={isCamStarting}
            cameraSuppressed={uplinkVideoSuppressed}
            isScreenSharing={isScreenSharing}
            screenQuality={screenQuality}
            micDevices={micDevices}
            activeMicId={activeMicId}
            isMicSwitching={isMicSwitching}
            collapsed={controlsCollapsed}
            whiteboardOpen={whiteboardOpen}
            onToggleWhiteboard={toggleWhiteboard}
            annotationActive={annotationActive}
            canAnnotate={canAnnotate}
            onToggleAnnotation={handleAnnotationButtonClick}
            onToggleCollapsed={() => setControlsCollapsed((v) => !v)}
            onToggleMic={toggleMic}
            onToggleCam={handleToggleCam}
            onToggleScreenShare={toggleScreenShare}
            onSetScreenQuality={setScreenQuality}
            onSwitchMic={switchMic}
            onLeave={handleLeave}
          />
        </div>
      )}
      </div>

      {/* Chat panel — slides in from the right. A sticky arrow tab peeks out
          from the left edge of the panel, matching the participants panel handle
          pattern used in the screen-share layout.

          OVERLAY_INTERACTIVE_ATTR: в overlay-режиме (Electron) панель и её
          стрелка-хэндл должны «ловить» клики, иначе hit-test через
          elementFromPoint не ��айдёт интерактивный маркер и клик уйдёт сквозь
          окно на рабочий стол. */}
      <div
        {...{ [OVERLAY_INTERACTIVE_ATTR]: "true" }}
        className={cn(
          "fixed inset-y-0 right-0 flex transition-transform duration-300 ease-in-out",
          // В overlay-режиме доска растянута на всё окно с z-9980, поэтому чат
          // нужно поднять выше неё (но ниже overlay-контролов на z-9990+).
          overlayMode ? "z-[9985]" : "z-30",
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
          onUploadFile={uploadChatFile}
          mediaBaseUrl={mediaBaseUrl}
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

      {/* Annotation toolbar — floats above the controls while drawing is active */}
      {!overlayMode && annotationActive && canAnnotate && (
        <div className="fixed bottom-28 left-1/2 z-40 -translate-x-1/2">
          <AnnotationToolbar
            tool={annotationTool}
            color={annotationColor}
            penWidth={annotationPenWidth}
            onToolChange={setAnnotationTool}
            onColorChange={setAnnotationColor}
            onPenWidthChange={setAnnotationPenWidth}
            onClear={triggerAnnotationClear}
            onClose={() => setAnnotationActive(false)}
          />
        </div>
      )}

      {/* Overlay-режим (Electron, мы демонстрируем экран): рисование поверх
          рабочего стола. Полноэкранный прозрачный холст и контролы вынесены в
          RoomOverlayLayer. */}
      <RoomSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsTab} />

      {overlayMode && (
        <RoomOverlayLayer
          annotationActive={annotationActive}
          annotationTool={annotationTool}
          annotationColor={annotationColor}
          annotationPenWidth={annotationPenWidth}
          annotationClearSignal={annotationClearSignal}
          onToolChange={setAnnotationTool}
          onColorChange={setAnnotationColor}
          onPenWidthChange={setAnnotationPenWidth}
          onCloseAnnotation={() => setAnnotationActive(false)}
          onToggleAnnotation={handleAnnotationButtonClick}
          onClearAnnotation={triggerAnnotationClear}
          sendAnnotationStroke={sendAnnotationStroke}
          sendAnnotationClear={sendAnnotationClear}
          subscribeAnnotationStroke={subscribeAnnotationStroke}
          subscribeAnnotationClear={subscribeAnnotationClear}
          isMicMuted={isMicMuted}
          isCamOff={isCamOff}
          cameraSuppressed={uplinkVideoSuppressed}
          whiteboardOpen={whiteboardOpen}
          onToggleWhiteboard={toggleWhiteboard}
          onToggleMic={toggleMic}
          onToggleCam={handleToggleCam}
          onStopScreenShare={stopScreenShare}
        />
      )}
    </div>
  )
}
