import type { Socket } from "socket.io-client"

const INTERVAL_MS = 3000
const LOW_FPS = 15

function enabled(): boolean {
  if (typeof window === "undefined") return false
  if (new URLSearchParams(window.location.search).get("screenDebug") === "1") return true
  try {
    return window.sessionStorage.getItem("replixo:screen-fps") === "1"
  } catch {
    return false
  }
}

function log(stage: string, fps: number | undefined, details: object, active: boolean) {
  const low = active && fps !== undefined && fps < LOW_FPS
  const line = `[screen-fps]${low ? "[LOW]" : ""} ${stage} ${JSON.stringify({
    time: new Date().toISOString(),
    fps,
    ...details,
  })}`
  if (low) console.warn(line)
  else console.info(line)
}

function delta(current: number | undefined, previous: number | undefined): number | undefined {
  return typeof current === "number" && typeof previous === "number" && current >= previous
    ? current - previous
    : undefined
}

function rate(count: number | undefined, seconds: number): number | undefined {
  return count !== undefined && seconds > 0 ? Math.round(count / seconds * 10) / 10 : undefined
}

interface ScreenEndpoint {
  closed: boolean
  paused: boolean
  track: MediaStreamTrack | null
  getStats(): Promise<RTCStatsReport>
}

interface RtpSample {
  id: string
  trackId?: string
  timestamp: number
  framesEncoded?: number
  framesSent?: number
  framesReceived?: number
  framesDecoded?: number
  framesDropped?: number
  packetsLost?: number
  bytesSent?: number
  bytesReceived?: number
}

type ScreenFpsStage = "send" | "receive" | "playback"

interface ScreenFpsMetrics {
  fps?: number
  captureFps?: number
  encodedFps?: number
  receivedFps?: number
  droppedFrames?: number
  kbps?: number
  lostPackets?: number
  rttMs?: number
  jitterMs?: number
  limitation?: string
  muted?: boolean
  paused?: boolean
  visibility?: DocumentVisibilityState
}

interface ServerDiagnostics {
  active: () => boolean
  send: (stage: ScreenFpsStage, sample: ScreenFpsMetrics) => void
}

export function createScreenFpsReporter(
  socketRef: { current: Socket | null },
  deadlineRef: { current: number },
  ids: { producerId: string; consumerId?: string },
): ServerDiagnostics {
  return {
    active: () => performance.now() < deadlineRef.current,
    send: (stage, sample) => {
      const socket = socketRef.current
      if (socket?.connected) socket.volatile.emit("screenFpsSample", { stage, ...ids, ...sample })
    },
  }
}

const playbackReporters = new WeakMap<MediaStream, ServerDiagnostics>()

export function monitorScreenReceive(endpoint: ScreenEndpoint, stream: MediaStream, producerId: string, server: ServerDiagnostics) {
  if (server.active()) playbackReporters.set(stream, server)
  monitorScreenRtp(endpoint, "receive", producerId, server)
}

export function monitorScreenRtp(endpoint: ScreenEndpoint, stage: "send" | "receive", producerId: string, server?: ServerDiagnostics) {
  const local = enabled()
  const active = () => !endpoint.closed && (local || server?.active())
  if (!active()) return
  const sending = stage === "send"
  let previous: RtpSample | undefined
  const sample = async () => {
    if (!active()) return
    try {
      const stats = await endpoint.getStats()
      if (!active()) return
      const report = [...stats.values()].find((entry) =>
        entry.type === (sending ? "outbound-rtp" : "inbound-rtp") &&
        (entry.kind === "video" || entry.mediaType === "video"),
      )
      if (!report) return
      const trackId = endpoint.track?.id
      const remote = report.remoteId ? stats.get(report.remoteId) : undefined
      const current: RtpSample = { ...report, trackId, packetsLost: report.packetsLost ?? remote?.packetsLost }
      const last = previous
      previous = current
      if (!last || last.id !== current.id || last.trackId !== trackId || last.timestamp >= current.timestamp) return
      const seconds = (current.timestamp - last.timestamp) / 1000
      const fps = sending
        ? rate(delta(current.framesSent, last.framesSent) ?? delta(current.framesEncoded, last.framesEncoded), seconds)
        : rate(delta(current.framesDecoded, last.framesDecoded), seconds)
      const source = report.mediaSourceId ? stats.get(report.mediaSourceId) : undefined
      const transport = report.transportId ? stats.get(report.transportId) : undefined
      const pair = transport?.selectedCandidatePairId ? stats.get(transport.selectedCandidatePairId) : undefined
      const bytes = delta(current.bytesSent ?? current.bytesReceived, last.bytesSent ?? last.bytesReceived)
      const rtt = remote?.roundTripTime ?? pair?.currentRoundTripTime
      const jitter = report.jitter ?? remote?.jitter
      const metrics = {
        captureFps: source?.framesPerSecond,
        encodedFps: rate(delta(current.framesEncoded, last.framesEncoded), seconds),
        receivedFps: rate(delta(current.framesReceived, last.framesReceived), seconds),
        droppedFrames: delta(current.framesDropped, last.framesDropped),
        lostPackets: delta(current.packetsLost, last.packetsLost),
        rttMs: rtt === undefined ? undefined : Math.round(rtt * 1000),
        jitterMs: jitter === undefined ? undefined : Math.round(jitter * 1000),
        kbps: rate(bytes === undefined ? undefined : bytes * 8 / 1000, seconds),
        limitation: report.qualityLimitationReason,
        muted: endpoint.track?.muted,
        paused: endpoint.paused,
      }
      if (local) {
        const size = report.frameWidth && report.frameHeight ? `${report.frameWidth}x${report.frameHeight}` : undefined
        log(stage, fps, { producerId, trackId, size, ...metrics }, !endpoint.paused && !endpoint.track?.muted)
      }
      if (server?.active()) server.send(stage, { fps, ...metrics })
    } catch {
      // Stats can be unavailable while the connection is being rebuilt.
      previous = undefined
    } finally {
      if (active()) setTimeout(sample, INTERVAL_MS)
    }
  }
  void sample()
}

export function monitorScreenPlayback(video: HTMLVideoElement, stream: MediaStream) {
  const local = enabled()
  const server = playbackReporters.get(stream)
  if ((!local && !server?.active()) || typeof video.getVideoPlaybackQuality !== "function") return
  const trackId = stream.getVideoTracks()[0]?.id
  let previous = video.getVideoPlaybackQuality()
  const timer = setInterval(() => {
    if (!local && !server?.active()) {
      clearInterval(timer)
      return
    }
    const current = video.getVideoPlaybackQuality()
    const frames = delta(current.totalVideoFrames, previous.totalVideoFrames)
    const dropped = delta(current.droppedVideoFrames, previous.droppedVideoFrames)
    const seconds = (current.creationTime - previous.creationTime) / 1000
    previous = current
    if (frames === undefined || dropped === undefined) return
    const fps = rate(Math.max(0, frames - dropped), seconds)
    const details = {
      droppedFrames: dropped,
      paused: video.paused,
      visibility: document.visibilityState,
    }
    if (local) {
      log("playback", fps, { trackId, size: `${video.videoWidth}x${video.videoHeight}`, ...details },
        !video.paused && document.visibilityState === "visible")
    }
    if (server?.active()) server.send("playback", { fps, ...details })
  }, INTERVAL_MS)
  return () => clearInterval(timer)
}
