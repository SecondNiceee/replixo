"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { VideoTile } from "@/components/video-tile"
import { PresentationViewer } from "@/components/presentation-viewer"
import { cn } from "@/lib/utils"
import type { RefObject } from "react"
import type { SlideState } from "@/hooks/use-mediasoup"

interface Peer {
  peerId: string
  displayName: string
  videoStream?: MediaStream
  audioStream?: MediaStream
  screenStream?: MediaStream
  screenAudioStream?: MediaStream
  presentationStream?: MediaStream
  audioMuted?: boolean
}

interface RoomVideoGridProps {
  localStream: MediaStream | null
  localScreenStream: MediaStream | null
  displayName: string
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  isPresenting: boolean
  peers: Map<string, Peer>
  currentSlide: SlideState | null
  presentationFile: File | null
  presentationCanvasRef: RefObject<HTMLCanvasElement | null>
  onSlideChange: (slide: number, total: number) => void
  onPresentationLoaded: (total: number) => void
  onStopPresentation: () => void
  // Drawing sync
  presentationDrawings?: Map<number, string>
  onSendStroke?: (slideIndex: number, stroke: unknown) => void
  onClearDrawing?: (slideIndex: number) => void
  onSaveDrawingSnapshot?: (slideIndex: number, dataURL: string) => void
  subscribeRemoteStroke?: (fn: (event: { slideIndex: number; stroke: unknown }) => void) => () => void
  subscribeRemoteClear?: (fn: (event: { slideIndex: number }) => void) => () => void
}

export function RoomVideoGrid({
  localStream,
  localScreenStream,
  displayName,
  isMicMuted,
  isCamOff,
  isScreenSharing,
  isPresenting,
  peers,
  currentSlide,
  presentationFile,
  presentationCanvasRef,
  onSlideChange,
  onPresentationLoaded,
  onStopPresentation,
  presentationDrawings,
  onSendStroke,
  onClearDrawing,
  onSaveDrawingSnapshot,
  subscribeRemoteStroke,
  subscribeRemoteClear,
}: RoomVideoGridProps) {
  const [participantsHidden, setParticipantsHidden] = useState(false)

  const allPeers = [...peers.values()]
  const presentingPeer = allPeers.find((p) => p.presentationStream)
  const remoteScreens = allPeers.filter((p) => p.screenStream)

  const hasPresentation = isPresenting || !!presentingPeer || (currentSlide !== null && currentSlide !== undefined)
  const hasScreenShare = (isScreenSharing && localScreenStream) || remoteScreens.length > 0

  const totalTiles =
    allPeers.length + 1 + (isScreenSharing && localScreenStream ? 1 : 0) + remoteScreens.length

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

  // Participants shown as a vertical column on the right during a presentation.
  // Collapsible via a chevron handle (same pattern as the bottom controls bar).
  const participantsColumn = (
    <div className="flex h-full w-32 flex-col gap-2 overflow-y-auto overflow-x-hidden pr-0.5 sm:w-40 lg:w-48">
      <VideoTile
        stream={localStream ?? undefined}
        speakingStream={localStream ?? undefined}
        displayName={displayName}
        isMuted={isMicMuted}
        isCamOff={isCamOff}
        isLocal
        className="aspect-video w-full shrink-0 shadow-lg"
      />
      {allPeers.map((peer) => (
        <VideoTile
          key={peer.peerId}
          stream={peer.videoStream}
          audioStream={peer.audioStream}
          displayName={peer.displayName}
          isMuted={!peer.audioStream || !!peer.audioMuted}
          className="aspect-video w-full shrink-0 shadow-lg"
        />
      ))}
    </div>
  )

  // Presentation layout — document fills the screen, with participants shown as
  // a collapsible vertical column on the right.
  if (hasPresentation) {
    return (
      <main className="relative flex flex-1 gap-1 overflow-hidden p-1 sm:gap-2 sm:p-2">
        <div className="min-h-0 flex-1">
          <PresentationViewer
            isPresenter={isPresenting}
            currentSlide={currentSlide}
            onSlideChange={onSlideChange}
            onPresentationLoaded={onPresentationLoaded}
            onStop={onStopPresentation}
            canvasRef={isPresenting ? presentationCanvasRef : undefined}
            remoteStream={presentingPeer?.presentationStream}
            file={presentationFile}
            presentationDrawings={presentationDrawings}
            onSendStroke={onSendStroke}
            onClearDrawing={onClearDrawing}
            onSaveDrawingSnapshot={onSaveDrawingSnapshot}
            subscribeRemoteStroke={subscribeRemoteStroke}
            subscribeRemoteClear={subscribeRemoteClear}
          />
        </div>

        {/* Right participants panel + collapse handle */}
        <div className="relative flex shrink-0">
          {/* Toggle handle — always visible on the left edge of the panel */}
          <button
            onClick={() => setParticipantsHidden((v) => !v)}
            aria-label={participantsHidden ? "Показать участников" : "Скрыть участников"}
            className="absolute -left-7 top-1/2 z-10 flex h-14 w-7 -translate-y-1/2 items-center justify-center rounded-l-xl border border-r-0 border-border bg-background/90 backdrop-blur-sm transition-colors hover:bg-accent"
          >
            <ChevronRight
              className={cn(
                "size-4 text-muted-foreground transition-transform duration-300",
                participantsHidden && "rotate-180",
              )}
            />
          </button>

          {/* Collapsing area: animates width to 0 via the grid-cols 1fr/0fr trick */}
          <div
            className={cn(
              "grid h-full transition-[grid-template-columns] duration-300 ease-in-out",
              participantsHidden ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
            )}
          >
            <div className="h-full overflow-hidden">{participantsColumn}</div>
          </div>
        </div>
      </main>
    )
  }

  // Screen share layout
  if (hasScreenShare) {
    return (
      <main className="flex flex-1 flex-col gap-2 overflow-hidden p-3 lg:flex-row">
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
    <main className={cn("grid min-h-0 flex-1 auto-rows-fr gap-2 p-3", gridClass)}>
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
