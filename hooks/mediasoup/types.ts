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

// A device identity that survives reloads, tab duplication and new windows.
// It lives in localStorage (shared by every tab of the same origin/profile) so
// one human always maps to ONE participant, no matter how many tabs they open.
export const DEVICE_ID_KEY = "replixo_device_id"

// Legacy per-tab key. Removed on first read so old sessions don't keep a
// tab-scoped identity that would still produce duplicate participants.
const LEGACY_PEER_ID_KEY = "replixo_peer_session_id"

let memoryDeviceId: string | null = null

function createRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function getOrCreateDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId
  if (typeof window === "undefined") return createRandomId()

  try {
    window.sessionStorage.removeItem(LEGACY_PEER_ID_KEY)
  } catch {
    // Ignore: sessionStorage may be unavailable.
  }

  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY)
    if (stored) {
      memoryDeviceId = stored
      return stored
    }
    memoryDeviceId = createRandomId()
    window.localStorage.setItem(DEVICE_ID_KEY, memoryDeviceId)
  } catch {
    // Storage can be blocked in private/embedded contexts. The in-memory ID
    // still remains stable for the lifetime of this page.
    memoryDeviceId = createRandomId()
  }

  return memoryDeviceId
}

// FNV-1a. Two passes with different offset bases give a 64-bit digest, which
// keeps accidental collisions between two devices in one room negligible.
function fnv1a(input: string, seed: number): string {
  let hash = seed
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * Deterministic per-(device, room) peer identifier.
 *
 * Opening the same room again in another tab/window yields the SAME peerId, so
 * the server's duplicate check in `joinRoom` kicks the stale session instead of
 * letting a "clone" occupy a second slot and fight over producers. Different
 * rooms get different ids, so a delayed disconnect in room A can never evict
 * the same device from room B.
 */
export function getOrCreatePeerId(roomId: string): string {
  // Match the server's room canonicalisation (case-insensitive, separators
  // ignored) so "abc-defg" and "ABCDEFG" resolve to the same peer identity.
  const room = (roomId ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const scope = `${getOrCreateDeviceId()}|${room}`
  return `${fnv1a(scope, 0x811c9dc5)}${fnv1a(scope, 0x9e3779b9)}`
}
