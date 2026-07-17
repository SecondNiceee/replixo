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

// Форма совпадает с тем, что возвращает upload-эндпоинт сервера и что
// сервер рассылает в chatMessage: { url, name, size, mime }.
export interface ChatAttachment {
  url: string
  name: string
  size: number
  mime: string
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

/**
 * Резолвит URL Mediasoup/Socket.io сервера.
 *
 * Приоритет:
 * 1. Явная переменная `NEXT_PUBLIC_MEDIASOUP_URL` (вшивается на этапе сборки).
 * 2. В браузере на проде — тот же origin, что и приложение: nginx проксирует
 *    `/socket.io/` на mediasoup, поэтому отдельный хост/порт не нужен.
 * 3. Локальная разработка (localhost/127.0.0.1) — `http://localhost:3001`.
 */
function resolveServerUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_MEDIASOUP_URL
  if (explicit && explicit.length > 0) {
    return explicit.replace(/\/+$/, "")
  }

  if (typeof window !== "undefined") {
    const { hostname, origin } = window.location
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:3001"
    }
    // Прод: коннектимся на тот же домен, nginx роутит /socket.io/ на mediasoup.
    return origin
  }

  return "http://localhost:3001"
}

export const SERVER_URL = resolveServerUrl()

export const PEER_ID_KEY = "replixo_peer_session_id"

let memoryPeerId: string | null = null

function createPeerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function getOrCreatePeerId(): string {
  if (memoryPeerId) return memoryPeerId
  if (typeof window === "undefined") return createPeerId()

  try {
    const stored = window.sessionStorage.getItem(PEER_ID_KEY)
    if (stored) {
      memoryPeerId = stored
      return stored
    }
    memoryPeerId = createPeerId()
    window.sessionStorage.setItem(PEER_ID_KEY, memoryPeerId)
  } catch {
    // Storage can be blocked in private/embedded contexts. The in-memory ID
    // still remains stable for the lifetime of this page.
    memoryPeerId = createPeerId()
  }

  return memoryPeerId
}
