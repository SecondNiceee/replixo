// mediasoup-client is a CJS bundle with internal circular dependencies that
// cause a TDZ crash when Turbopack tries to statically analyse it.
// Use local shim types; load the real module lazily via import().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeviceType = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Transport = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Producer = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Consumer = any

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface RemotePeer {
  peerId: string
  displayName: string
  videoStream?: MediaStream
  audioStream?: MediaStream
  screenStream?: MediaStream
  screenAudioStream?: MediaStream
  /** Whether this peer's microphone producer is currently paused (muted). */
  audioMuted?: boolean
}

export type MediaSource = "media" | "screen"

export type StreamKey =
  | "screenStream"
  | "screenAudioStream"
  | "videoStream"
  | "audioStream"

export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"

export type ScreenQuality = "auto" | "720p" | "1080p"

export interface ScreenQualityPreset {
  video: MediaTrackConstraints
  maxBitrate?: number
}

export const SCREEN_QUALITY_PRESETS: Record<ScreenQuality, ScreenQualityPreset> = {
  auto: {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  },
  "720p": {
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    maxBitrate: 2_500_000,
  },
  "1080p": {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    maxBitrate: 8_000_000,
  },
}

export interface ChatAttachment {
  filename: string
  size: number
  mimeType: string
  url: string
}

export interface ChatMessage {
  id: string
  peerId: string
  displayName: string
  text: string
  timestamp: number
  self: boolean
  attachment?: ChatAttachment | null
}

// Camera simulcast layers
export const CAMERA_ENCODINGS = [
  { maxBitrate: 100_000, scaleResolutionDownBy: 4 },
  { maxBitrate: 300_000, scaleResolutionDownBy: 2 },
  { maxBitrate: 900_000, scaleResolutionDownBy: 1 },
]

export const CAMERA_PRODUCE_OPTIONS = {
  encodings: CAMERA_ENCODINGS,
  codecOptions: { videoGoogleStartBitrate: 1000 },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeSource(raw: unknown): MediaSource {
  return raw === "screen" ? "screen" : "media"
}

export function streamKeyFor(source: MediaSource, kind: "video" | "audio"): StreamKey {
  if (source === "screen") return kind === "video" ? "screenStream" : "screenAudioStream"
  return kind === "video" ? "videoStream" : "audioStream"
}

export const SERVER_URL =
  process.env.NEXT_PUBLIC_MEDIASOUP_SERVER_URL ?? "http://localhost:3001"

export const PEER_ID_KEY = "replixo_peer_id"

export function getOrCreatePeerId(): string {
  if (typeof window === "undefined") return crypto.randomUUID()
  let id = localStorage.getItem(PEER_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(PEER_ID_KEY, id)
  }
  return id
}
