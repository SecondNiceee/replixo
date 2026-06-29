"use client"


import { ChevronRight } from "lucide-react"
import { VideoTile } from "@/components/video-tile"
import { cn } from "@/lib/utils"
import { useOverlayClickThrough } from "@/hooks/use-overlay-click-through"

interface Peer {
  peerId: string
  displayName: string
  videoStream?: MediaStream
  audioStream?: MediaStream
  screenStream?: MediaStream
  screenAudioStream?: MediaStream
  audioMuted?: boolean
}

interface RoomVideoGridProps {
  localStream: MediaStream | null
  localScreenStream: MediaStream | null
  displayName: string
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  peers: Map<string, Peer>
  participantsHidden?: boolean
  onParticipantsHiddenChange?: (hidden: boolean) => void
  /** Electron overlay-режим: показывать только правый сайдбар участников поверх прозрачного окна */
  overlayMode?: boolean
}

export function RoomVideoGrid({
  localStream,
  localScreenStream,
  displayName,
  isMicMuted,
  isCamOff,
  isScreenSharing,
  peers,
  participantsHidden = false,
  onParticipantsHiddenChange,
  overlayMode = false,
}: RoomVideoGridProps) {
  const setParticipantsHidden = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(participantsHidden) : v
    onParticipantsHiddenChange?.(next)
  }

  // Click-through для интерактивных областей overlay-режима (Electron)
  const overlayClickThrough = useOverlayClickThrough()

  const allPeers = [...peers.values()]
  const remoteScreens = allPeers.filter((p) => p.screenStream)

  const hasScreenShare = (isScreenSharing && localScreenStream) || remoteScreens.length > 0

  // ---------------------------------------------------------------------------
  // Overlay-режим: окно прозрачное поверх экрана. Показываем только
  // вертикальный сайдбар участников справа — без видео своего экрана.
  // ---------------------------------------------------------------------------
  if (overlayMode) {
    const allParticipantsOverlay: Array<
      | { key: string; isLocal: true }
      | { key: string; isLocal: false; peer: Peer }
    > = [
      { key: "local", isLocal: true },
      ...allPeers.map((peer) => ({ key: peer.peerId, isLocal: false as const, peer })),
    ]

    return (
      <div className="pointer-events-none fixed inset-y-0 left-0 z-[9998] flex items-center">
        {/* Toggle handle — sits on the RIGHT edge of the left sidebar */}
        <button
          {...overlayClickThrough}
          onClick={() => onParticipantsHiddenChange?.(!participantsHidden)}
          aria-label={participantsHidden ? "Показать участников" : "Скрыть участников"}
          className={cn(
            "pointer-events-auto absolute -right-7 top-1/2 z-10 flex h-14 w-7 -translate-y-1/2 items-center justify-center rounded-r-xl border border-l-0 border-white/15 bg-black/60 backdrop-blur-md transition-colors hover:bg-black/80",
          )}
        >
          <ChevronRight
            className={cn(
              "size-4 text-white/60 transition-transform duration-300",
              participantsHidden ? "rotate-0" : "rotate-180",
            )}
          />
        </button>

        {/* Collapsing sidebar — collapses to the left (width → 0) */}
        <div
          className={cn(
            "grid overflow-hidden transition-all duration-300 ease-in-out",
            participantsHidden ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
          )}
        >
          <div {...overlayClickThrough} className="pointer-events-auto min-w-0 overflow-hidden">
            <div className="flex h-screen flex-col overflow-y-auto border-r border-white/10 bg-black/70 shadow-2xl backdrop-blur-xl lg:w-52">
              {/* Header */}
              <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                  Участники
                </span>
                <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-white/10 px-1.5 text-[10px] font-bold tabular-nums text-white/50">
                  {allParticipantsOverlay.length}
                </span>
              </div>

              {/* Tiles */}
              {allParticipantsOverlay.map((item, idx) => (
                <div
                  key={item.key}
                  className={cn(idx !== 0 && "border-t border-white/10")}
                >
                  {item.isLocal ? (
                    <VideoTile
                      stream={localStream ?? undefined}
                      speakingStream={localStream ?? undefined}
                      displayName={displayName}
                      isMuted={isMicMuted}
                      isCamOff={isCamOff}
                      isLocal
                      className="aspect-video h-auto w-full rounded-none shadow-none ring-0"
                    />
                  ) : (
                    <VideoTile
                      stream={item.peer.videoStream}
                      audioStream={item.peer.audioStream}
                      displayName={item.peer.displayName}
                      isMuted={!item.peer.audioStream || !!item.peer.audioMuted}
                      className="aspect-video h-auto w-full rounded-none shadow-none ring-0"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const totalTiles = allPeers.length + 1 + (isScreenSharing && localScreenStream ? 1 : 0) + remoteScreens.length

  const gridClass =
    totalTiles === 1
      ? "grid-cols-1"
      : totalTiles === 2
        ? "grid-cols-2"
        : totalTiles <= 4
          ? "grid-cols-2"
          : "grid-cols-3"

  const allParticipants: Array<
    | { key: string; isLocal: true }
    | { key: string; isLocal: false; peer: Peer }
  > = [
    { key: "local", isLocal: true },
    ...allPeers.map((peer) => ({ key: peer.peerId, isLocal: false as const, peer })),
  ]

  const sidebarTiles = (
    <div className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl ring-1 ring-white/5 backdrop-blur-md lg:w-52">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
          Участники
        </span>
        <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-white/10 px-1.5 text-[10px] font-bold tabular-nums text-white/50">
          {allParticipants.length}
        </span>
      </div>

      {/* Tiles — horizontal scroll on mobile, vertical on lg */}
      <div className="flex overflow-x-auto lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
        {allParticipants.map((item, idx) => (
          <div
            key={item.key}
            className={cn(
              "shrink-0",
              idx !== 0 && "border-l border-white/10 lg:border-l-0 lg:border-t lg:border-white/10",
            )}
          >
            {item.isLocal ? (
              <VideoTile
                stream={localStream ?? undefined}
                speakingStream={localStream ?? undefined}
                displayName={displayName}
                isMuted={isMicMuted}
                isCamOff={isCamOff}
                isLocal
                className="aspect-video h-28 w-auto rounded-none shadow-none ring-0 lg:h-auto lg:w-full"
              />
            ) : (
              <VideoTile
                stream={item.peer.videoStream}
                audioStream={item.peer.audioStream}
                displayName={item.peer.displayName}
                isMuted={!item.peer.audioStream || !!item.peer.audioMuted}
                className="aspect-video h-28 w-auto rounded-none shadow-none ring-0 lg:h-auto lg:w-full"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )

  // Screen share layout
  if (hasScreenShare) {
    return (
      <main className="flex flex-1 flex-col gap-2 overflow-hidden bg-black p-2 lg:flex-row">
        {/* Collapsible participants panel — bottom strip on mobile, LEFT column
            on large screens. Выезжает слева. */}
        <div className="relative flex shrink-0">
          {/* Toggle handle: sits below the strip on mobile, on the right edge of
              the column on large screens */}
          <button
            onClick={() => setParticipantsHidden((v) => !v)}
            aria-label={participantsHidden ? "Показать участников" : "Скрыть участников"}
            className={cn(
              "absolute left-1/2 -bottom-7 z-10 flex h-7 w-14 -translate-x-1/2 items-center justify-center rounded-b-xl border border-t-0 border-border bg-background/90 backdrop-blur-sm transition-colors hover:bg-accent",
              "lg:left-auto lg:-right-7 lg:top-1/2 lg:h-14 lg:w-7 lg:-translate-x-0 lg:-translate-y-1/2 lg:rounded-b-none lg:rounded-r-xl lg:border-t lg:border-l-0",
            )}
          >
            <ChevronRight
              className={cn(
                "size-4 -rotate-90 text-muted-foreground transition-transform duration-300 lg:rotate-180",
                participantsHidden && "rotate-90 lg:rotate-0",
              )}
            />
          </button>

          {/* Collapsing area: height collapses on mobile, width on large screens */}
          <div
            className={cn(
              "grid overflow-hidden transition-all duration-300 ease-in-out",
              participantsHidden
                ? "grid-rows-[0fr] lg:grid-rows-[1fr] lg:grid-cols-[0fr]"
                : "grid-rows-[1fr] lg:grid-cols-[1fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">{sidebarTiles}</div>
          </div>
        </div>

        <div
          className={cn(
            "grid min-h-0 flex-1 gap-2",
            remoteScreens.length + (isScreenSharing && localScreenStream ? 1 : 0) > 1
              ? "grid-cols-1 sm:grid-cols-2"
              : "grid-cols-1",
          )}
        >
          {isScreenSharing && localScreenStream && (
            <VideoTile
              key="local-screen"
              stream={localScreenStream}
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
        </div>
      </main>
    )
  }

  // Default camera grid
  return (
    <main className={cn("grid min-h-0 flex-1 auto-rows-fr gap-2 bg-black p-2", gridClass)}>
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
          isMuted={!peer.audioStream || !!peer.audioMuted}
          className="h-full w-full"
        />
      ))}
    </main>
  )
}
