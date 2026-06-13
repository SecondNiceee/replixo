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
// We therefore ALWAYS ship a TURN relay. If the operator provides their own
// (TURN_URL — may be a comma-separated list of urls), we use it; otherwise we
// fall back to the free public OpenRelay TURN servers, which work over
// UDP/TCP/TLS on ports 80/443 so they survive restrictive mobile and corporate
// firewalls.
//
// IMPORTANT for cross-city / cross-ISP calls: the free fallback is rate-limited
// and shared, so it can stutter under load. For reliable production calls set
// your own TURN_URL (e.g. a coturn instance or a Metered/Twilio account).
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

const fallbackTurn = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

export const iceServers = [
  { urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Prefer a custom TURN if configured, otherwise use the public fallback.
  ...(customTurn.length > 0 ? customTurn : fallbackTurn),
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
  initialAvailableOutgoingBitrate: 3_000_000,
  minimumAvailableOutgoingBitrate: 100_000,
  maxSctpMessageSize: 262144,
}
