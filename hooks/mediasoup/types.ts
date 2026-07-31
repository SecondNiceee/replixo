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
  /**
   * Whether this peer's camera producer is currently paused. Distinct from
   * "no videoStream at all" (camera off): the track still exists, the sender
   * simply stopped it — typically their weak-network guard sacrificing video to
   * keep voice alive. Without this the tile would freeze on the last decoded
   * frame with no explanation.
   */
  videoPaused?: boolean
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
// Voice codec options
//
// Single source of truth for how the microphone is published, so the initial
// publish, a mic switch and the post-reconnect catch-up publish can never drift
// apart (they used to carry three separate copies of this object).
//
// Opus is configured to survive a bad network rather than to sound pristine:
//  - `opusFec` adds in-band forward error correction, so isolated lost packets
//    are reconstructed instead of producing an audible gap.
//  - `opusDtx` stops sending during silence, which frees the uplink for the
//    people who are actually talking.
//  - `opusPtime: 40` packs 40 ms of audio per packet instead of the default
//    20 ms. That halves the packet rate and the per-packet IP/UDP/RTP overhead
//    (~40 % of the payload at 20 ms), which matters a lot more than the extra
//    20 ms of latency once the link is congested. Also fewer packets means
//    fewer chances to be dropped by an overloaded queue.
// ---------------------------------------------------------------------------
export const VOICE_CODEC_OPTIONS = {
  opusFec: true,
  opusDtx: true,
  opusPtime: 40,
  opusMaxAverageBitrate: 64_000,
}

export const VOICE_PRODUCE_OPTIONS = {
  codecOptions: VOICE_CODEC_OPTIONS,
}

// ---------------------------------------------------------------------------
// Weak-network guard tuning
//
// Aggregated here so the thresholds can be reasoned about in one place instead
// of being scattered as magic numbers across the monitoring loop.
// ---------------------------------------------------------------------------
export const NETWORK_GUARD = {
  /** How often uplink/downlink stats are sampled. */
  SAMPLE_INTERVAL_MS: 2000,
  /**
   * Consecutive "bad" samples required before video is dropped. 3 × 2 s means a
   * momentary spike (a single lost burst, a passing tunnel) never kills video —
   * only a sustained problem does.
   */
  BAD_SAMPLES_TO_SUPPRESS: 3,
  /**
   * Consecutive fully-"good" samples required before video comes back. Longer
   * than the suppression window on purpose: restoring too eagerly is what makes
   * video flap on and off, which is far worse UX than staying audio-only.
   */
  GOOD_SAMPLES_TO_RESTORE: 5,
  /** Minimum time video stays suppressed, regardless of how good stats look. */
  MIN_SUPPRESSION_MS: 15_000,
  /**
   * If video has to be suppressed again shortly after being restored, the
   * minimum suppression window doubles (capped here). Prevents a "restore →
   * congest → suppress" loop on a link that simply cannot carry video.
   */
  MAX_SUPPRESSION_MS: 120_000,
  /** A re-suppression within this window after a restore counts as a failure. */
  FLAP_WINDOW_MS: 60_000,

  /** Audio loss ratio (0..1) that counts as a degraded link. */
  WEAK_LOSS: 0.04,
  /** Audio loss ratio (0..1) at which video must go. */
  BAD_LOSS: 0.12,
  /**
   * Available outgoing bitrate below which video cannot coexist with voice.
   * The lowest camera simulcast layer alone asks for 100 kbps and mediasoup
   * will not go below it, so under ~180 kbps video simply starves the mic.
   */
  BAD_UPLINK_BPS: 180_000,
  WEAK_UPLINK_BPS: 400_000,
  /** Round-trip time (seconds) that indicates a badly congested path. */
  BAD_RTT_S: 1.0,

  /** Opus target bitrate per quality level. */
  VOICE_BITRATE: { good: 64_000, weak: 40_000, bad: 24_000 },
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

// Peer identity is stored per room in localStorage, which is shared by every
// tab of the same browser profile. So one human always maps to ONE participant,
// no matter how many tabs they open, while different rooms get independent ids
// (a delayed disconnect in room A can never evict this browser from room B).
const PEER_ID_PREFIX = "replixo_peer_id:"

// Legacy per-tab key. Removed on first read so old sessions don't keep a
// tab-scoped identity that would still produce duplicate participants.
const LEGACY_PEER_ID_KEY = "replixo_peer_session_id"

const memoryPeerIds = new Map<string, string>()

function createRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Nonce identifying THIS page instance, generated once per page load and never
 * persisted. `peerId` alone cannot tell a reconnect of this very page apart
 * from a second tab (both send the same peerId with a fresh socket id), so the
 * server compares `clientId` too — otherwise a Wi-Fi/VPN hand-off would look
 * like a duplicate and the page would kick itself out of the room.
 */
export const CLIENT_ID = createRandomId()

function peerIdKey(roomId: string): string {
  // Match the server's room canonicalisation (case-insensitive, separators
  // ignored) so "abc-defg" and "ABCDEFG" resolve to the same peer identity.
  const room = (roomId ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  return `${PEER_ID_PREFIX}${room || "default"}`
}

/**
 * Stable per-(browser profile, room) peer identifier.
 *
 * Opening the same room again in another tab/window yields the SAME peerId, so
 * the server's duplicate check in `joinRoom` kicks the stale session instead of
 * letting a "clone" occupy a second slot and fight over producers.
 */
export function getOrCreatePeerId(roomId: string): string {
  const key = peerIdKey(roomId)
  const cached = memoryPeerIds.get(key)
  if (cached) return cached
  if (typeof window === "undefined") return createRandomId()

  let peerId: string | null = null
  try {
    window.sessionStorage.removeItem(LEGACY_PEER_ID_KEY)
  } catch {
    // Ignore: sessionStorage may be unavailable.
  }

  try {
    peerId = window.localStorage.getItem(key)
    if (!peerId) {
      peerId = createRandomId()
      window.localStorage.setItem(key, peerId)
    }
  } catch {
    // Storage can be blocked in private/embedded contexts. The in-memory ID
    // still remains stable for the lifetime of this page.
    peerId = peerId ?? createRandomId()
  }

  memoryPeerIds.set(key, peerId)
  return peerId
}
