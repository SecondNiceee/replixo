"use client"

import { use } from "react"
import { useRouter } from "next/navigation"
import { Mic, MicOff, Video, VideoOff, PhoneOff, Copy, Check, ChevronDown, Pencil, MonitorUp, MonitorOff } from "lucide-react"
import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { EditNameDialog } from "@/components/edit-name-dialog"
import { getDisplayName } from "@/lib/display-name"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { VideoTile } from "@/components/video-tile"
import { EnableSoundBanner } from "@/components/enable-sound-banner"
import { useMediasoup, type ScreenQuality } from "@/hooks/use-mediasoup"
import { useAudioDevices } from "@/hooks/use-audio-devices"
import { cn } from "@/lib/utils"

const SCREEN_QUALITY_OPTIONS: { value: ScreenQuality; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p (Full HD)" },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>
  searchParams: Promise<{ create?: string }>
}) {
  const { roomId } = use(params)
  const { create } = use(searchParams)
  const router = useRouter()
  const displayName = getDisplayName()
  const [editNameOpen, setEditNameOpen] = useState(false)

  const handleNameSaved = useCallback(() => {
    // Reconnect with the new name so other peers see the update.
    window.location.reload()
  }, [])

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
  } = useMediasoup(roomId, displayName, create === "true")

  const { devices: micDevices } = useAudioDevices()
  const [selectedMicLabel, setSelectedMicLabel] = useState<string | null>(null)

  const [copied, setCopied] = useState(false)

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(roomId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [roomId])

  const handleLeave = useCallback(() => {
    leave()
    router.push("/")
  }, [leave, router])

  // -------------------------------------------------------------------------
  // Loading / error states
  // -------------------------------------------------------------------------
  if (status === "idle" || status === "connecting") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <div className="size-10 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Подключение к комнате {roomId}…</p>
      </div>
    )
  }

  if (status === "error") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push("/")}>
          На главную
        </Button>
      </div>
    )
  }

  if (status === "disconnected") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-sm text-muted-foreground">Вы покинули комнату</p>
        <Button variant="outline" onClick={() => router.push("/")}>
          На главную
        </Button>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Active call
  // -------------------------------------------------------------------------
  const allPeers = [...peers.values()]

  // Collect every active screen share (local + remote) as primary "stage" tiles.
  const remoteScreens = allPeers.filter((p) => p.screenStream)
  const hasScreenShare = (isScreenSharing && localScreenStream) || remoteScreens.length > 0

  // Camera tiles (local + remote) shown either in the grid or the filmstrip.
  const totalTiles =
    allPeers.length + 1 + (isScreenSharing && localScreenStream ? 1 : 0) + remoteScreens.length

  // Grid layout based on participant count (only used when nobody is sharing).
  const gridClass =
    totalTiles === 1
      ? "grid-cols-1"
      : totalTiles === 2
        ? "grid-cols-2"
        : totalTiles <= 4
          ? "grid-cols-2"
          : "grid-cols-3"

  // Camera tiles rendered as a reusable list so they can live in the grid
  // (no screen share) or in the filmstrip (screen share active).
  const cameraTiles = (
    <>
      <VideoTile
        stream={localStream ?? undefined}
        speakingStream={localStream ?? undefined}
        displayName={displayName}
        isMuted={isMicMuted}
        isCamOff={isCamOff}
        isLocal
        className="h-full w-full"
      />
      {allPeers.map((peer) => (
        <VideoTile
          key={peer.peerId}
          stream={peer.videoStream}
          audioStream={peer.audioStream}
          displayName={peer.displayName}
          className="h-full w-full"
        />
      ))}
    </>
  )

  // Screen share tiles rendered as the large "stage" content.
  const screenTiles = (
    <>
      {isScreenSharing && localScreenStream && (
        <VideoTile
          key="local-screen"
          stream={localScreenStream}
          speakingStream={undefined}
          displayName={displayName}
          isLocal
          isScreen
          className="h-full w-full"
        />
      )}
      {remoteScreens.map((peer) => (
        <VideoTile
          key={`${peer.peerId}-screen`}
          stream={peer.screenStream}
          audioStream={peer.screenAudioStream}
          displayName={peer.displayName}
          isScreen
          className="h-full w-full"
        />
      ))}
    </>
  )

  return (
    <div className="flex h-screen flex-col bg-background">
      <EnableSoundBanner />
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground">Riplexo</span>
          <span className="h-4 w-px bg-border" />
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs font-mono text-muted-foreground transition-colors hover:text-foreground"
          >
            {roomId}
            {copied ? (
              <Check className="size-3 text-green-500" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEditNameOpen(true)}
            className="group flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Изменить имя"
          >
            <span className="max-w-[120px] truncate font-medium">{displayName}</span>
            <Pencil className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
          </button>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                status === "connected" ? "bg-green-500" : "bg-muted-foreground",
              )}
            />
            <span className="text-xs text-muted-foreground">
              {peers.size + 1} участник{peers.size + 1 !== 1 ? "а" : ""}
            </span>
          </div>
        </div>
      </header>

      {/* Video area */}
      {hasScreenShare ? (
        // Speaker layout: screen share takes the stage, cameras in a filmstrip.
        <main className="flex flex-1 flex-col gap-2 overflow-hidden p-3 lg:flex-row">
          {/* Stage — one or more shared screens */}
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-2",
              remoteScreens.length + (isScreenSharing && localScreenStream ? 1 : 0) > 1
                ? "grid-cols-1 sm:grid-cols-2"
                : "grid-cols-1",
            )}
          >
            {screenTiles}
          </div>

          {/* Filmstrip — camera tiles */}
          <div className="flex shrink-0 gap-2 overflow-x-auto lg:w-52 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
            {[
              <VideoTile
                key="local"
                stream={localStream ?? undefined}
                speakingStream={localStream ?? undefined}
                displayName={displayName}
                isMuted={isMicMuted}
                isCamOff={isCamOff}
                isLocal
                className="aspect-video h-28 w-auto shrink-0 lg:h-auto lg:w-full"
              />,
              ...allPeers.map((peer) => (
                <VideoTile
                  key={peer.peerId}
                  stream={peer.videoStream}
                  audioStream={peer.audioStream}
                  displayName={peer.displayName}
                  className="aspect-video h-28 w-auto shrink-0 lg:h-auto lg:w-full"
                />
              )),
            ]}
          </div>
        </main>
      ) : (
        // Default grid layout when nobody is sharing their screen.
        <main className={cn("grid flex-1 gap-2 p-3", gridClass)}>{cameraTiles}</main>
      )}

      {/* Controls */}
      <footer className="flex items-center justify-center gap-3 border-t border-border px-5 py-4">
        {/* Mic button + device picker */}
        <div className="flex items-center">
          <Button
            variant="outline"
            onClick={toggleMic}
            className={cn(
              "size-12 rounded-full rounded-r-none border-r-0",
              isMicMuted && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
            )}
            aria-label={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
          >
            {isMicMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-12 w-6 rounded-l-none px-1",
                  isMicMuted && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
                )}
                aria-label="Выбрать микрофон"
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top">
              {micDevices.length === 0 && (
                <DropdownMenuItem disabled>��ет доступных микрофонов</DropdownMenuItem>
              )}
              {micDevices.map((d) => (
                <DropdownMenuItem
                  key={d.deviceId}
                  onSelect={async () => {
                    setSelectedMicLabel(d.label)
                    await switchMic(d.deviceId)
                  }}
                  className={cn(selectedMicLabel === d.label && "font-medium")}
                >
                  {d.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={toggleCam}
          className={cn(
            "size-12 rounded-full",
            isCamOff && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
          )}
          aria-label={isCamOff ? "Включить камеру" : "Выключить камеру"}
        >
          {isCamOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
        </Button>

        {/* Screen share button + quality picker */}
        <div className="flex items-center">
          <Button
            variant="outline"
            onClick={toggleScreenShare}
            className={cn(
              "size-12 rounded-full rounded-r-none border-r-0",
              isScreenSharing && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
            )}
            aria-label={isScreenSharing ? "Остановить демонстрацию экрана" : "Демонстрация экрана"}
          >
            {isScreenSharing ? <MonitorOff className="size-5" /> : <MonitorUp className="size-5" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-12 w-6 rounded-l-none px-1",
                  isScreenSharing && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
                )}
                aria-label="Качество демонстрации экрана"
              >
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Качество экрана</DropdownMenuLabel>
                {SCREEN_QUALITY_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onSelect={() => setScreenQuality(opt.value)}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className={cn(screenQuality === opt.value && "font-medium")}>{opt.label}</span>
                    {screenQuality === opt.value && <Check className="size-3.5 text-foreground" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Button
          variant="destructive"
          size="icon"
          onClick={handleLeave}
          className="size-12 rounded-full"
          aria-label="Покинуть комнату"
        >
          <PhoneOff className="size-5" />
        </Button>
      </footer>

      <EditNameDialog
        open={editNameOpen}
        onOpenChange={setEditNameOpen}
        currentName={displayName}
        onSaved={handleNameSaved}
      />
    </div>
  )
}
