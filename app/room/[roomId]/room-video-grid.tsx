"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { VideoTile } from "@/components/video-tile"
import { cn } from "@/lib/utils"

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
}

export function RoomVideoGrid({
  localStream,
  localScreenStream,
  displayName,
  isMicMuted,
  isCamOff,
  isScreenSharing,
  peers,
}: RoomVideoGridProps) {
  const [participantsHidden, setParticipantsHidden] = useState(false)

  const allPeers = [...peers.values()]
  const remoteScreens = allPeers.filter((p) => p.screenStream)

  const hasScreenShare = (isScreenSharing && localScreenStream) || remoteScreens.length > 0

  const totalTiles = allPeers.length + 1 + (isScreenSharing && localScreenStream ? 1 : 0) + remoteScreens.length

  const gridClass =
    totalTiles === 1
      ? "grid-cols-1"
      : totalTiles === 2
        ? "grid-cols-2"
        : totalTiles <= 4
          ? "grid-cols-2"
          : "grid-cols-3"

  const sidebarTiles = (
    <div className="flex shrink-0 gap-2 overflow-x-auto lg:w-52 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
      <VideoTile
        stream={localStream ?? undefined}
        speakingStream={localStream ?? undefined}
        displayName={displayName}
        isMuted={isMicMuted}
        isCamOff={isCamOff}
        isLocal
        className="aspect-video h-28 w-auto shrink-0 lg:h-auto lg:w-full"
      />
      {allPeers.map((peer) => (
        <VideoTile
          key={peer.peerId}
          stream={peer.videoStream}
          audioStream={peer.audioStream}
          displayName={peer.displayName}
          isMuted={!peer.audioStream || !!peer.audioMuted}
          className="aspect-video h-28 w-auto shrink-0 lg:h-auto lg:w-full"
        />
      ))}
    </div>
  )

  // Screen share layout
  if (hasScreenShare) {
    return (
      <main className="flex flex-1 flex-col gap-2 overflow-hidden bg-black lg:flex-row">
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

        {/* Collapsible participants panel — bottom strip on mobile, right column
            on large screens. Toggle handle uses the same pattern as the
            presentation layout and the bottom controls bar. */}
        <div className="relative flex shrink-0">
          {/* Toggle handle: sits above the strip on mobile, on the left edge of
              the column on large screens */}
          <button
            onClick={() => setParticipantsHidden((v) => !v)}
            aria-label={participantsHidden ? "Показать участников" : "Скрыть участников"}
            className={cn(
              "absolute left-1/2 -top-7 z-10 flex h-7 w-14 -translate-x-1/2 items-center justify-center rounded-t-xl border border-b-0 border-border bg-background/90 backdrop-blur-sm transition-colors hover:bg-accent",
              "lg:left-auto lg:-left-7 lg:top-1/2 lg:h-14 lg:w-7 lg:-translate-x-0 lg:-translate-y-1/2 lg:rounded-t-none lg:rounded-l-xl lg:border-b lg:border-r-0",
            )}
          >
            <ChevronRight
              className={cn(
                "size-4 rotate-90 text-muted-foreground transition-transform duration-300 lg:rotate-0",
                participantsHidden && "rotate-[270deg] lg:rotate-180",
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
      </main>
    )
  }

  // Default camera grid
  return (
    <main className={cn("grid min-h-0 flex-1 auto-rows-fr gap-2 bg-black", gridClass)}>
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
