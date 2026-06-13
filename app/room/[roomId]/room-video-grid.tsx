"use client"

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
}: RoomVideoGridProps) {
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
          className="aspect-video h-28 w-auto shrink-0 lg:h-auto lg:w-full"
        />
      ))}
    </div>
  )

  // Presentation layout
  if (hasPresentation) {
    return (
      <main className="flex flex-1 flex-col gap-2 overflow-hidden p-3 lg:flex-row">
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
          />
        </div>
        {sidebarTiles}
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
        {sidebarTiles}
      </main>
    )
  }

  // Default camera grid
  return (
    <main className={cn("grid flex-1 gap-2 p-3", gridClass)}>
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
    </main>
  )
}
