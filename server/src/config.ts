import 'dotenv/config'
import type { RtpCodecCapability, TransportListenIp, WorkerLogTag } from 'mediasoup/node/lib/types'

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = parseInt(process.env.PORT ?? '3001', 10)
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:3000'
export const MAX_PEERS_PER_ROOM = 5

// ---------------------------------------------------------------------------
// WebRTC / ICE
// ---------------------------------------------------------------------------

const announcedIp = process.env.ANNOUNCED_IP ?? undefined

export const listenIps: TransportListenIp[] = [
  {
    ip: '0.0.0.0',
    announcedIp,
  },
]

// ICE servers sent to every WebRTC client.
//
// STUN alone is NOT enough for phone <-> PC calls: mobile carriers put phones
// behind symmetric NAT (CGNAT), which STUN cannot traverse. Without a TURN
// relay the media path silently fails and the remote person "can't be heard".
//
// We therefore ship the operator's own TURN relay. TURN_URL may be a single
// url or a comma-separated list (e.g. UDP + TCP/TLS variants of the same
// coturn instance). All entries share the same TURN_USERNAME / TURN_CREDENTIAL.
const customTurnUrls = (process.env.TURN_URL ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)

const customTurn = customTurnUrls.length > 0
  ? customTurnUrls.map((urls) => ({
      urls,
      username: process.env.TURN_USERNAME ?? '',
      credential: process.env.TURN_CREDENTIAL ?? '',
    }))
  : []

export const iceServers = [
  { urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // The operator's own TURN relay (set via TURN_URL / TURN_USERNAME / TURN_CREDENTIAL).
  ...customTurn,
]

// ---------------------------------------------------------------------------
// Mediasoup Worker
// ---------------------------------------------------------------------------

export const workerSettings = {
  rtcMinPort: 40000,
  rtcMaxPort: 49999,
  logLevel: 'warn' as const,
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'] as WorkerLogTag[],
}

// ---------------------------------------------------------------------------
// Router media codecs
// ---------------------------------------------------------------------------

export const mediaCodecs = [
  {
    kind: 'audio' as const,
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video' as const,
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
  {
    kind: 'video' as const,
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
] as RtpCodecCapability[]

// ---------------------------------------------------------------------------
// WebRtcTransport options
// ---------------------------------------------------------------------------

export const webRtcTransportOptions = {
  listenIps,
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  // Start the bandwidth estimator high so screen shares are crisp from the
  // first second instead of ramping up from a blurry low-bitrate state.
  initialAvailableOutgoingBitrate: 6_000_000,
  minimumAvailableOutgoingBitrate: 300_000,
  maxSctpMessageSize: 262144,
}
