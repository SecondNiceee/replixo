import 'dotenv/config'
import os from 'os'
import path from 'path'
import type { RtpCodecCapability, TransportListenIp, WorkerLogTag } from 'mediasoup/types'

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = parseInt(process.env.PORT ?? '3001', 10)
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:3000'
export const MAX_PEERS_PER_ROOM = 7

// Общий секрет для запросов «Next-сервер → этот сервер» (маршруты /internal/*).
// У них нет пользовательской сессии: их дёргает Next-роут после успешной записи
// в Postgres, о которой сокет-сервер сам узнать не может. Пока секрет не задан,
// /internal/* отвечает 503 — открытым такой маршрут не бывает никогда.
// Значение обязано совпадать с INTERNAL_HOOK_SECRET у Next-приложения.
export const INTERNAL_HOOK_SECRET = process.env.INTERNAL_HOOK_SECRET ?? ''

// ---------------------------------------------------------------------------
// Вложения чата (файлы хранятся на диске VPS, без внешних blob-хранилищ)
// ---------------------------------------------------------------------------

// Корневая папка для вложений. Внутри — по подпапке на каждую комнату:
// <UPLOAD_DIR>/<roomId>/<uuid>.<ext>. Папка комнаты удаляется целиком, когда
// комната уничтожается (см. socket.ts → cleanupRoomIfEmpty).
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')

// Максимальный размер одного файла (байты). По умолчанию 25 МБ.
export const MAX_FILE_SIZE = parseInt(
  process.env.MAX_FILE_SIZE ?? String(25 * 1024 * 1024),
  10,
)

// Подпапка внутри UPLOAD_DIR для вложений личных чатов:
// <UPLOAD_DIR>/dm/<conversationId>/<uuid>.<ext>.
//
// Принципиально отличается от папок комнат: история ЛС постоянна, поэтому эти
// файлы НЕ удаляются ни по завершении чего-либо, ни фоновым TTL-сборщиком.
// Имя вынесено в конфиг, чтобы sweepOrphanUploads мог исключить папку по той
// же константе, а не по строковому литералу в двух местах.
export const DM_UPLOAD_SUBDIR = 'dm'

// ---------------------------------------------------------------------------
// Установщик приложения (большой файл ~900 МБ, лежит на диске VPS, НЕ в git)
// ---------------------------------------------------------------------------

// Абсолютный путь к .exe-установщику для Windows. Файл кладётся на диск сервера
// вручную (через scp/rsync) и НЕ коммитится в репозиторий. Маршрут /download/windows
// отдаёт именно этот файл. По умолчанию ищем в <cwd>/downloads/Replixo-Setup-version-4.exe.
export const WINDOWS_INSTALLER_PATH =
  process.env.WINDOWS_INSTALLER_PATH ??
  path.join(process.cwd(), 'downloads', 'Replixo-Setup-version-4.exe')

// Имя файла, под которым установщик будет сохранён у пользователя.
export const WINDOWS_INSTALLER_NAME =
  process.env.WINDOWS_INSTALLER_NAME ?? 'Replixo-Setup-version-4.exe'

// Подстраховка от "осиротевших" файлов после жёсткого падения сервера (когда
// штатная очистка при уничтожении комнаты не успела отработать). Папки комнат,
// не изменявшиеся дольше этого срока, удаляются фоновым сборщиком. По умолчанию
// 48 часов — заведомо больше любого живого звонка.
export const UPLOAD_TTL_MS = parseInt(
  process.env.UPLOAD_TTL_MS ?? String(48 * 60 * 60 * 1000),
  10,
)

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

// Behind the load balancer all call media goes through ONE fixed port
// (UDP + TCP) served by a mediasoup WebRtcServer. That port is forwarded 1:1 in
// balancer-nginx/nginx-18u101-stream.conf, so no port ranges or variables are
// needed there. Without RTC_PORT (local dev) every transport opens its own port
// from rtcMinPort..rtcMaxPort as before.
const rtcPort = process.env.RTC_PORT ? parseInt(process.env.RTC_PORT, 10) : null

// Number of mediasoup workers. One worker = one CPU core, so with a single
// worker the second core sits idle. Each worker behind the balancer needs its
// own port: worker #i listens on RTC_PORT + i, and every such port must be
// forwarded in balancer-nginx/nginx-18u101-stream.conf. Defaults to 1 so an
// existing single-port deployment keeps working unchanged.
export const MEDIASOUP_WORKERS = Math.max(
  1,
  Math.min(os.cpus().length || 1, parseInt(process.env.MEDIASOUP_WORKERS ?? '1', 10) || 1),
)

export function webRtcServerOptionsFor(workerIndex: number) {
  if (!rtcPort) return null
  const port = rtcPort + workerIndex
  return {
    listenInfos: [
      { protocol: 'udp' as const, ip: '0.0.0.0', announcedAddress: announcedIp, port },
      { protocol: 'tcp' as const, ip: '0.0.0.0', announcedAddress: announcedIp, port },
    ],
  }
}

// ---------------------------------------------------------------------------
// Abuse limits (protect the single VPS from scripted floods)
// ---------------------------------------------------------------------------

function intEnv(name: string, fallback: number): number {
  const value = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Behind nginx every request comes from the balancer, so the real client IP is
// taken from X-Real-IP. Set TRUST_PROXY=0 only if port 3001 is exposed directly
// (then the header could be forged and the socket address is used instead).
export const TRUST_PROXY = process.env.TRUST_PROXY !== '0'

// Total rooms on this server (live + being created). Each room holds a
// mediasoup router plus whiteboard state in memory.
export const MAX_ROOMS = intEnv('MAX_ROOMS', 300)
// Concurrent call sockets from one IP. Generous enough for a school or office
// behind one NAT, small enough that one script can't open thousands.
export const MAX_SOCKETS_PER_IP = intEnv('MAX_SOCKETS_PER_IP', 40)
// New rooms one IP may create per ROOM_CREATE_WINDOW_MS.
export const MAX_ROOM_CREATIONS_PER_IP = intEnv('MAX_ROOM_CREATIONS_PER_IP', 20)
export const ROOM_CREATE_WINDOW_MS = 10 * 60_000
// A peer normally has at most mic + camera + screen video + screen audio.
export const MAX_PRODUCERS_PER_PEER = 8
// Enough for every producer of a full room plus recovery re-consumes.
export const MAX_CONSUMERS_PER_PEER = 96
// Room chat attachments: per-IP upload rate and per-room disk quota.
export const MAX_UPLOADS_PER_IP_PER_MINUTE = intEnv('MAX_UPLOADS_PER_IP_PER_MINUTE', 20)
export const ROOM_UPLOAD_QUOTA = intEnv('ROOM_UPLOAD_QUOTA', 500 * 1024 * 1024)
// Socket.io drops any single message above this size. Whiteboard and slide
// snapshots are accepted up to 5 MB, so the buffer must be a bit larger
// (the default of 1 MB silently discarded big boards).
export const SOCKET_MAX_MESSAGE_BYTES = 6 * 1024 * 1024

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
  // Behind the load balancer every media port has to be forwarded through its
  // nginx stream block, so production narrows this via RTC_MIN_PORT/RTC_MAX_PORT
  // to the exact range listed in balancer-nginx/nginx-18u101-stream.conf.
  rtcMinPort: parseInt(process.env.RTC_MIN_PORT ?? '40000', 10),
  rtcMaxPort: parseInt(process.env.RTC_MAX_PORT ?? '49999', 10),
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
    // Keep router capabilities neutral. Voice and screen-share music need
    // different DTX/bitrate settings, which are negotiated per producer.
    parameters: {
      'useinbandfec': 1,
      'maxplaybackrate': 48000,
    },
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
