"use client"

import { useEffect, useRef, useCallback, useReducer, useState } from "react"
import { io, Socket } from "socket.io-client"
import { playJoinSound, playLeaveSound, playScreenShareSound, playScreenShareStopSound } from "@/lib/sounds"
// mediasoup-client is a CJS bundle with internal circular dependencies that
// cause a TDZ crash ("Cannot access 'X' before initialization") when Turbopack
// tries to statically analyse it — even via `import type`.
// We avoid ALL static imports from mediasoup-client and instead:
//   1. Use local minimal shim types below (compile-time only, zero runtime cost).
//   2. Load the real module lazily with `await import("mediasoup-client")` inside
//      the async join() callback that only ever runs in the browser.

// Minimal shim types — mirrors what we actually use from mediasoup-client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeviceType = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transport = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Producer = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Consumer = any

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemotePeer {
  peerId: string
  displayName: string
  videoStream?: MediaStream
  audioStream?: MediaStream
  screenStream?: MediaStream
  screenAudioStream?: MediaStream
  presentationStream?: MediaStream
  // Whether this peer's microphone producer is currently paused (muted).
  // Driven by the server's `producerPaused` broadcast and the initial
  // `producerPaused` flag returned when we first consume their audio.
  audioMuted?: boolean
}

export type MediaSource = "media" | "screen" | "presentation"

// Normalise an untrusted `appData.source` value (string | unknown) into one of
// our known MediaSource variants, defaulting to "media".
function normalizeSource(raw: unknown): MediaSource {
  return raw === "screen" ? "screen" : raw === "presentation" ? "presentation" : "media"
}

// The RemotePeer field that a given (source, kind) pair maps to.
type StreamKey =
  | "presentationStream"
  | "screenStream"
  | "screenAudioStream"
  | "videoStream"
  | "audioStream"

function streamKeyFor(source: MediaSource, kind: "video" | "audio"): StreamKey {
  if (source === "presentation") return "presentationStream"
  if (source === "screen") return kind === "video" ? "screenStream" : "screenAudioStream"
  return kind === "video" ? "videoStream" : "audioStream"
}

export type RoomStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"

export type ScreenQuality = "auto" | "720p" | "1080p"

interface ScreenQualityPreset {
  video: MediaTrackConstraints
  // undefined maxBitrate => let WebRTC adapt freely (Auto)
  maxBitrate?: number
}

export const SCREEN_QUALITY_PRESETS: Record<ScreenQuality, ScreenQualityPreset> = {
  // Adaptive: WebRTC scales resolution/bitrate to the available bandwidth.
  auto: {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  },
  // 720p: lighter on bandwidth, smooth on weaker connections.
  "720p": {
    video: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    maxBitrate: 2_500_000,
  },
  // Full HD: pinned resolution + high bitrate for crisp text.
  "1080p": {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    maxBitrate: 5_000_000,
  },
}

export interface SlideState {
  peerId: string
  slide: number
  total: number
}

export interface ChatMessage {
  id: string
  peerId: string
  displayName: string
  text: string
  timestamp: number
  // true when this message was sent by the local user
  self: boolean
}

// Camera simulcast layers. Publishing three spatial layers lets the SFU drop
// to a lower layer per-receiver when their downlink is weak (e.g. a peer in
// another city on a poor connection) instead of freezing/stalling the single
// high-bitrate stream for everyone. Bitrates are conservative so the call
// survives on modest uplinks; WebRTC ramps up when bandwidth allows.
const CAMERA_ENCODINGS = [
  { rid: "low", maxBitrate: 150_000, scaleResolutionDownBy: 4, scalabilityMode: "L1T3" },
  { rid: "mid", maxBitrate: 500_000, scaleResolutionDownBy: 2, scalabilityMode: "L1T3" },
  { rid: "high", maxBitrate: 1_500_000, scaleResolutionDownBy: 1, scalabilityMode: "L1T3" },
]

// Codec preference / per-layer config passed alongside the simulcast encodings.
const CAMERA_PRODUCE_OPTIONS = {
  encodings: CAMERA_ENCODINGS,
  codecOptions: {
    videoGoogleStartBitrate: 300,
  },
} as const

interface State {
  status: RoomStatus
  error: string | null
  peers: Map<string, RemotePeer>
  localStream: MediaStream | null
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  isPresenting: boolean
  // whether the user has ever enabled mic/cam (i.e. track exists)
  hasMic: boolean
  hasCam: boolean
  // active slide state from any presenter (null = no presentation)
  currentSlide: SlideState | null
  // chat messages, oldest first
  messages: ChatMessage[]
  // peerId -> timestamp (ms) of the latest message that peer has read.
  // Used to render "delivered/read" checkmarks on the local user's messages.
  readMarkers: Record<string, number>
  // Shared whiteboard (tldraw). `whiteboardOpen` mirrors the room-wide flag so
  // the board appears/disappears for everyone at once. `whiteboardSnapshot` is
  // the latest full document snapshot used to seed the canvas when it mounts
  // (initial join or a peer opening it mid-session). Live edits flow separately
  // as incremental diffs through a ref-based subscription, not through state.
  whiteboardOpen: boolean
  whiteboardSnapshot: string | null
}

type Action =
  | { type: "CONNECTING" }
  | { type: "CONNECTED"; localStream: MediaStream }
  | { type: "ERROR"; error: string }
  | { type: "DISCONNECTED" }
  | { type: "PEER_JOINED"; peerId: string; displayName: string }
  | { type: "PEER_STREAM"; peerId: string; displayName: string; kind: "video" | "audio"; source: MediaSource; stream: MediaStream }
  | { type: "PEER_PRODUCER_CLOSED"; peerId: string; source: MediaSource; kind: "video" | "audio" }
  | { type: "PEER_AUDIO_MUTED"; peerId: string; muted: boolean }
  | { type: "PEER_LEFT"; peerId: string }
  | { type: "TOGGLE_MIC"; isMuted: boolean; hasMic?: boolean }
  | { type: "TOGGLE_CAM"; isOff: boolean; hasCam?: boolean }
  | { type: "SET_SCREEN_SHARING"; isSharing: boolean }
  | { type: "SET_PRESENTING"; isPresenting: boolean }
  | { type: "SET_SLIDE"; slide: SlideState | null }
  | { type: "STOP_PRESENTING" }
  | { type: "ADD_MESSAGE"; message: ChatMessage }
  | { type: "SET_READ_MARKER"; peerId: string; ts: number }
  | { type: "SET_WHITEBOARD"; open: boolean; snapshot?: string | null }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "CONNECTING":
      return { ...state, status: "connecting", error: null }
    case "CONNECTED":
      return { ...state, status: "connected", localStream: action.localStream }
    case "ERROR":
      return { ...state, status: "error", error: action.error }
    case "DISCONNECTED":
      return { ...state, status: "disconnected", localStream: null, peers: new Map(), hasMic: false, hasCam: false }
    case "PEER_JOINED": {
      const peers = new Map(state.peers)
      if (!peers.has(action.peerId)) {
        peers.set(action.peerId, { peerId: action.peerId, displayName: action.displayName })
      }
      return { ...state, peers }
    }
    case "PEER_STREAM": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId) ?? { peerId: action.peerId, displayName: action.displayName }
      const key = streamKeyFor(action.source, action.kind)
      peers.set(action.peerId, {
        ...existing,
        [key]: action.stream,
      })
      return { ...state, peers }
    }
    case "PEER_PRODUCER_CLOSED": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId)
      if (!existing) return state
      const key = streamKeyFor(action.source, action.kind)
      const updated = { ...existing }
      delete updated[key]
      // If their mic producer went away entirely, clear the muted flag so a
      // stale indicator doesn't linger.
      if (action.source === "media" && action.kind === "audio") {
        updated.audioMuted = false
      }
      peers.set(action.peerId, updated)
      return { ...state, peers }
    }
    case "PEER_AUDIO_MUTED": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId)
      if (!existing) return state
      if (existing.audioMuted === action.muted) return state
      peers.set(action.peerId, { ...existing, audioMuted: action.muted })
      return { ...state, peers }
    }
    case "PEER_LEFT": {
      const peers = new Map(state.peers)
      peers.delete(action.peerId)
      // If the leaving peer was the presenter, clear slide state immediately.
      // The server also emits presentationEnded, but handling it here makes the
      // reducer the single source of truth and avoids a two-event race.
      const currentSlide =
        state.currentSlide?.peerId === action.peerId ? null : state.currentSlide
      return { ...state, peers, currentSlide }
    }
    case "TOGGLE_MIC":
      return { ...state, isMicMuted: action.isMuted, hasMic: action.hasMic ?? state.hasMic }
    case "TOGGLE_CAM":
      return { ...state, isCamOff: action.isOff, hasCam: action.hasCam ?? state.hasCam }
    case "SET_SCREEN_SHARING":
      return { ...state, isScreenSharing: action.isSharing }
    case "SET_PRESENTING":
      return { ...state, isPresenting: action.isPresenting }
    case "STOP_PRESENTING":
      return { ...state, isPresenting: false, currentSlide: null }
    case "SET_SLIDE":
      return { ...state, currentSlide: action.slide }
    case "ADD_MESSAGE": {
      // Guard against duplicate ids (e.g. a re-emitted broadcast).
      if (state.messages.some((m) => m.id === action.message.id)) return state
      // Cap history so a long-running room can't grow memory unbounded.
      const next = [...state.messages, action.message]
      const messages = next.length > 500 ? next.slice(next.length - 500) : next
      return { ...state, messages }
    }
    case "SET_READ_MARKER": {
      // Read markers only move forward; ignore stale/out-of-order updates.
      const prev = state.readMarkers[action.peerId] ?? 0
      if (action.ts <= prev) return state
      return { ...state, readMarkers: { ...state.readMarkers, [action.peerId]: action.ts } }
    }
    case "SET_WHITEBOARD": {
      // Only overwrite the snapshot when one is explicitly provided; toggling
      // the board closed/open without a payload preserves the last snapshot.
      return {
        ...state,
        whiteboardOpen: action.open,
        whiteboardSnapshot:
          action.snapshot !== undefined ? action.snapshot : state.whiteboardSnapshot,
      }
    }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_URL =
  process.env.NEXT_PUBLIC_MEDIASOUP_URL ?? "http://localhost:3001"

const PEER_ID_KEY = "replixo_peer_id"

function getOrCreatePeerId(): string {
  if (typeof window === "undefined") return Math.random().toString(36).slice(2, 10)
  let id = localStorage.getItem(PEER_ID_KEY)
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(PEER_ID_KEY, id)
  }
  return id
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediasoup(roomId: string, displayName: string, create = false) {
  const [state, dispatch] = useReducer(reducer, {
    status: "idle",
    error: null,
    peers: new Map(),
    localStream: null,
    isMicMuted: true,
    isCamOff: true,
    isScreenSharing: false,
    isPresenting: false,
    hasMic: false,
    hasCam: false,
    currentSlide: null,
    messages: [],
    readMarkers: {},
    whiteboardOpen: false,
    whiteboardSnapshot: null,
  })

  const socketRef = useRef<Socket | null>(null)
  const deviceRef = useRef<DeviceType | null>(null)
  const sendTransportRef = useRef<Transport | null>(null)
  const recvTransportRef = useRef<Transport | null>(null)
  const peerId = useRef<string>(getOrCreatePeerId())
  const localStreamRef = useRef<MediaStream | null>(null)
  const videoProducerRef = useRef<Producer | null>(null)
  const audioProducerRef = useRef<Producer | null>(null)
  const screenVideoProducerRef = useRef<Producer | null>(null)
  const screenAudioProducerRef = useRef<Producer | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const presentationVideoProducerRef = useRef<Producer | null>(null)
  const presentationStreamRef = useRef<MediaStream | null>(null)
  const isPresentingRef = useRef(false)
  const selectedMicIdRef = useRef<string | undefined>(undefined)
  // currently selected screen-share quality preset
  const screenQualityRef = useRef<ScreenQuality>("auto")
  const [screenQuality, setScreenQualityState] = useState<ScreenQuality>("auto")
  // Live whiteboard diff subscribers. The socket "whiteboardChange" handler
  // fans incoming remote diffs out to every registered listener (the mounted
  // Whiteboard component). Kept in a ref so handlers stay stable and the join
  // effect never needs to re-run when the board mounts/unmounts.
  const whiteboardListenersRef = useRef<Set<(changes: unknown) => void>>(new Set())

  // consumerId -> Consumer
  const consumersRef = useRef<Map<string, Consumer>>(new Map())
  // producerIds that were closed before we finished consuming them (race guard)
  const pendingClosedProducersRef = useRef<Set<string>>(new Set())
  // whether an initial join has completed. Distinguishes a first connect from
  // a socket.io reconnection after a transient network drop.
  const hasJoinedRef = useRef(false)
  // set once this session was kicked (same peerId opened elsewhere). Prevents
  // any reconnect/rejoin so we don't ping-pong kick the other tab.
  const kickedRef = useRef(false)
  // mirrors state.status in a ref so join() can read it without being a dep
  const statusRef = useRef<RoomStatus>("idle")
  // Keep statusRef in sync — used inside callbacks to avoid stale closures.
  statusRef.current = state.status
  // guards against firing several overlapping ICE restarts for one transport
  const iceRestartingRef = useRef<Set<string>>(new Set())
  // per-transport retry timers — used to keep retrying an ICE restart until the
  // transport reports "connected" again (mobile networks often need several).
  const iceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Mirrors of mic/cam state in refs — readable inside async callbacks without
  // stale-closure issues. Updated in sync with every TOGGLE_MIC / TOGGLE_CAM dispatch.
  const isMicMutedRef = useRef(true)
  const hasMicRef = useRef(false)
  const isCamOffRef = useRef(true)
  const hasCamRef = useRef(false)
  // Keep mic/cam state refs in sync with the reducer.
  isMicMutedRef.current = state.isMicMuted
  hasMicRef.current = state.hasMic
  isCamOffRef.current = state.isCamOff
  hasCamRef.current = state.hasCam

  // -------------------------------------------------------------------------
  // Restart ICE on a transport whose network path broke (transient drop / VPN
  // switch / phone changing cell tower). The transport, its producers and
  // consumers all stay alive — only the ICE candidates are renegotiated, so
  // media resumes without re-creating anything and the peer never leaves.
  //
  // On mobile a single restart frequently isn't enough (the new path takes a
  // few seconds to settle), so we retry with backoff until the transport's
  // connectionstatechange reports "connected"/"completed", which clears the
  // timer via clearIceRetry().
  // -------------------------------------------------------------------------
  const clearIceRetry = useCallback((transportId: string) => {
    const t = iceRetryTimersRef.current.get(transportId)
    if (t) {
      clearTimeout(t)
      iceRetryTimersRef.current.delete(transportId)
    }
  }, [])

  const restartIceForTransport = useCallback(
    (transport: Transport | null, attempt = 0) => {
      const socket = socketRef.current
      if (!socket || !transport || transport.closed) return
      // Don't stack concurrent restarts, but DO allow scheduled retries.
      if (attempt === 0 && iceRestartingRef.current.has(transport.id)) return
      iceRestartingRef.current.add(transport.id)

      const scheduleRetry = () => {
        // Stop retrying once the transport recovered or was closed.
        if (transport.closed || transport.connectionState === "connected") {
          clearIceRetry(transport.id)
          return
        }
        // Backoff: 1s, 2s, 4s … capped at 8s. Retries indefinitely while the
        // transport stays broken so a phone that's been off-network for a
        // while still recovers the moment it comes back.
        const delay = Math.min(1000 * 2 ** attempt, 8000)
        clearIceRetry(transport.id)
        const timer = setTimeout(() => {
          restartIceForTransport(transport, attempt + 1)
        }, delay)
        iceRetryTimersRef.current.set(transport.id, timer)
      }

      socket.emit(
        "restartIce",
        { roomId, peerId: peerId.current, transportId: transport.id },
        async (error: string | null, iceParameters: object | undefined) => {
          iceRestartingRef.current.delete(transport.id)
          if (error || !iceParameters) {
            console.error("[useMediasoup] restartIce error:", error)
            scheduleRetry()
            return
          }
          try {
            await transport.restartIce({ iceParameters: iceParameters as RTCIceParameters })

            // After ICE renegotiation on the SEND transport, re-sync the paused
            // state of every active producer with the server. The server's
            // internal producerPaused flag may have drifted during the outage
            // (e.g. VPN toggle, phone switching towers). Without this step, a
            // muted user becomes audible again on the remote side after recovery.
            if (transport === sendTransportRef.current) {
              const syncSocket = socketRef.current
              if (syncSocket) {
                for (const producer of [
                  audioProducerRef.current,
                  videoProducerRef.current,
                  screenVideoProducerRef.current,
                  screenAudioProducerRef.current,
                ]) {
                  if (!producer || producer.closed) continue
                  syncSocket.emit("pauseProducer", {
                    roomId,
                    peerId: peerId.current,
                    producerId: producer.id,
                    paused: producer.paused,
                  })
                }
              }
            }

            // Verify it actually recovered; if not, keep retrying.
            scheduleRetry()
          } catch (e) {
            console.error("[useMediasoup] transport.restartIce failed:", e)
            scheduleRetry()
          }
        },
      )
    },
    [roomId, clearIceRetry],
  )

  // -------------------------------------------------------------------------
  // Force-recover the whole connection. Called when the app comes back to the
  // foreground / regains network on mobile, where the browser silently freezes
  // WebRTC and socket.io and does NOT always auto-fire a reconnect. We kick the
  // socket back to life and renegotiate ICE on both transports.
  // -------------------------------------------------------------------------
  // Timestamp of the last recoverConnection call — used to debounce spurious
  // triggers (e.g. window.focus fires on every tldraw canvas click, which would
  // otherwise send a rejoinProbe on every brush stroke).
  const lastRecoverAtRef = useRef(0)

  const recoverConnection = useCallback(() => {
    const socket = socketRef.current
    if (!socket || !hasJoinedRef.current) return

    // If the socket is disconnected, reconnect immediately (no debounce needed —
    // the "connect" event only fires once the socket is truly back).
    if (!socket.connected) {
      socket.connect()
      return
    }

    // Debounce ICE-restart probes to at most once every 5 seconds so that
    // high-frequency focus events (tldraw canvas, rapid tab switching) don't
    // flood the server with rejoinProbe requests.
    const now = Date.now()
    if (now - lastRecoverAtRef.current < 5000) return
    lastRecoverAtRef.current = now

    // Socket is alive but media may be frozen — probe + restart ICE.
    socket.emit(
      "rejoinProbe",
      { roomId, peerId: peerId.current },
      (error: string | null) => {
        if (!error) {
          restartIceForTransport(sendTransportRef.current)
          restartIceForTransport(recvTransportRef.current)
        }
        // If evicted, the next "connect" cycle handles the full rejoin.
      },
    )
  }, [roomId, restartIceForTransport])

  // -------------------------------------------------------------------------
  // consume a remote producer
  // -------------------------------------------------------------------------
  const consumeProducer = useCallback(
    async (
      remotePeerId: string,
      displayName: string,
      producerId: string,
      kind: "audio" | "video",
      appData?: Record<string, unknown>,
    ) => {
      const socket = socketRef.current
      const device = deviceRef.current
      const recvTransport = recvTransportRef.current
      if (!socket || !device || !recvTransport) return

      socket.emit(
        "consume",
        {
          roomId,
          peerId: peerId.current,
          producerId,
          rtpCapabilities: device.rtpCapabilities,
        },
        async (error: string | null, data: {
          consumerId: string
          producerId: string
          kind: string
          rtpParameters: object
          producerPaused: boolean
          appData: Record<string, unknown>
        } | undefined) => {
          if (error || !data) {
            console.error("[useMediasoup] consume error:", error)
            return
          }

          const rawSource =
            appData?.source ?? (data.appData as Record<string, unknown>)?.source
          const source: MediaSource =
            rawSource === "screen"
              ? "screen"
              : rawSource === "presentation"
                ? "presentation"
                : "media"

          const consumer = await recvTransport.consume({
            id: data.consumerId,
            producerId: data.producerId,
            kind: data.kind as "audio" | "video",
            rtpParameters: data.rtpParameters as RTCRtpParameters,
            appData: { source },
          })

          // Race guard: the producer may have been closed (e.g. peer stopped
          // screen sharing) before this consumer finished being created. If so,
          // tear it down immediately instead of leaving a stale tile.
          if (pendingClosedProducersRef.current.has(data.producerId)) {
            pendingClosedProducersRef.current.delete(data.producerId)
            consumer.close()
            dispatch({
              type: "PEER_PRODUCER_CLOSED",
              peerId: remotePeerId,
              source,
              kind,
            })
            return
          }

          consumersRef.current.set(consumer.id, consumer)

          const stream = new MediaStream([consumer.track])

          dispatch({
            type: "PEER_STREAM",
            peerId: remotePeerId,
            displayName,
            kind,
            source,
            stream,
          })

          // Seed the mic-muted indicator from the producer's initial paused
          // state, so a peer who muted before we joined shows as muted right
          // away (not just after a later pause/resume toggle).
          if (kind === "audio" && source === "media") {
            dispatch({
              type: "PEER_AUDIO_MUTED",
              peerId: remotePeerId,
              muted: !!data.producerPaused,
            })
          }

          // A remote peer started a demonstration (screen share or slides).
          // Gate on the video track so we play exactly one sound (screen share
          // can also carry an audio track, which we ignore here).
          if (kind === "video" && (source === "screen" || source === "presentation")) {
            playScreenShareSound()
          }

          // Resume consumer so it actually flows
          socket.emit(
            "resumeConsumer",
            { roomId, peerId: peerId.current, consumerId: consumer.id },
            (err: string | null) => {
              if (err) console.error("[useMediasoup] resumeConsumer error:", err)
            },
          )
        },
      )
    },
    [roomId],
  )

  // -------------------------------------------------------------------------
  // Create send/recv transports and start producing
  // -------------------------------------------------------------------------
  const createTransport = useCallback(
    (
      socket: Socket,
      device: DeviceType,
      direction: "send" | "recv",
    ): Promise<ReturnType<DeviceType["createSendTransport"]> | ReturnType<DeviceType["createRecvTransport"]>> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createWebRtcTransport",
          { roomId, peerId: peerId.current, direction },
          (error: string | null, transportData: {
            transportId: string
            iceParameters: object
            iceCandidates: object[]
            dtlsParameters: object
            iceServers: object[]
          } | undefined) => {
            if (error || !transportData) {
              reject(new Error(`createWebRtcTransport ${direction}: ${error}`))
              return
            }

            const opts = {
              id: transportData.transportId,
              iceParameters: transportData.iceParameters as RTCIceParameters,
              iceCandidates: transportData.iceCandidates as RTCIceCandidate[],
              dtlsParameters: transportData.dtlsParameters as RTCDtlsParameters,
              iceServers: transportData.iceServers as RTCIceServer[],
            }

            const transport =
              direction === "send"
                ? device.createSendTransport(opts)
                : device.createRecvTransport(opts)

            transport.on("connect", ({ dtlsParameters }, callback, errback) => {
              socket.emit(
                "connectTransport",
                { roomId, peerId: peerId.current, transportId: transport.id, dtlsParameters },
                (err: string | null) => {
                  if (err) errback(new Error(err))
                  else callback()
                },
              )
            })

            // When the underlying ICE/DTLS path breaks (transient network drop,
            // VPN toggle, phone switching towers), WebRTC reports "disconnected"
            // then "failed". Instead of tearing the call down, renegotiate ICE so
            // media resumes on the new network path. The peer stays in the room
            // the whole time. We keep retrying (with backoff) until the state
            // returns to "connected", at which point we stop.
            transport.on("connectionstatechange", (connectionState) => {
              if (connectionState === "disconnected" || connectionState === "failed") {
                restartIceForTransport(transport as Transport)
              } else if (connectionState === "connected") {
                // Recovered — stop any pending ICE-restart retries.
                clearIceRetry(transport.id)
              }
            })

            if (direction === "send") {
              (transport as ReturnType<DeviceType["createSendTransport"]>).on(
                "produce",
                ({ kind, rtpParameters, appData }, callback, errback) => {
                  socket.emit(
                    "produce",
                    { roomId, peerId: peerId.current, transportId: transport.id, kind, rtpParameters, appData },
                    (err: string | null, data: { producerId: string } | undefined) => {
                      if (err || !data) errback(new Error(err ?? "produce failed"))
                      else callback({ id: data.producerId })
                    },
                  )
                },
              )
            }

            resolve(transport)
          },
        )
      })
    },
    [roomId],
  )

  const setupTransports = useCallback(
    async (
      socket: Socket,
      device: DeviceType,
      existingPeers: Array<{
        peerId: string
        displayName: string
        producers: { producerId: string; kind: string; appData?: Record<string, unknown> }[]
      }>,
    ) => {
      // Both transports created in parallel, properly awaited
      const [sendTransport, recvTransport] = await Promise.all([
        createTransport(socket, device, "send"),
        createTransport(socket, device, "recv"),
      ])

      sendTransportRef.current = sendTransport as ReturnType<DeviceType["createSendTransport"]>
      recvTransportRef.current = recvTransport as ReturnType<DeviceType["createRecvTransport"]>

      // Consume existing peers — recv transport is guaranteed ready now
      for (const peer of existingPeers) {
        for (const { producerId, kind, appData } of peer.producers) {
          await consumeProducer(peer.peerId, peer.displayName, producerId, kind as "audio" | "video", appData)
        }
      }
    },
    [createTransport, consumeProducer],
  )

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------
  const join = useCallback(async () => {
    if (statusRef.current === "connecting" || statusRef.current === "connected") return

    dispatch({ type: "CONNECTING" })

    // Join without requesting camera/mic — user will enable them manually
    const localStream = new MediaStream()
    localStreamRef.current = localStream

    const socket = io(SERVER_URL, {
      // Allow polling as a fallback: some mobile/corporate networks block raw
      // websockets, and websocket-only would then never connect. socket.io
      // upgrades to websocket automatically once it's available.
      transports: ["websocket", "polling"],
      // Keep reconnecting indefinitely with short delays so a ~1-second network
      // blip re-establishes the signaling channel quickly. The server's
      // pingTimeout (30 s) ensures the peer is not evicted during this window.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      // Lower connect timeout so a stalled attempt fails fast and retries.
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on("connect_error", (e) => {
      // Only surface the error on the very first connection attempt.
      // Subsequent reconnect failures are handled silently by socket.io's
      // built-in retry logic — we do not want to flip the UI to "error" just
      // because the network hiccupped for a moment.
      if (!hasJoinedRef.current) {
        dispatch({ type: "ERROR", error: `Не удалось подключиться к серверу: ${e.message}` })
      }
    })

    // -----------------------------------------------------------------------
    // Core join sequence — called on first connect and on full rejoin after
    // the server evicts a peer during a long network drop.
    // -----------------------------------------------------------------------
    const doJoinSequence = async () => {
      const { Device } = await import("mediasoup-client")
      const device = new Device()
      deviceRef.current = device

      socket.emit(
        "joinRoom",
        {
          roomId,
          peerId: peerId.current,
          displayName,
          rtpCapabilities: {},
          create,
        },
        async (error: string | null, data: {
          rtpCapabilities: object
          existingPeers: Array<{
            peerId: string
            displayName: string
            producers: { producerId: string; kind: string; appData?: Record<string, unknown> }[]
          }>
          currentSlide?: SlideState | null
          messages?: Array<{ id: string; peerId: string; displayName: string; text: string; timestamp: number }>
          readMarkers?: Array<{ peerId: string; ts: number }>
          whiteboardOpen?: boolean
          whiteboardSnapshot?: string | null
        } | undefined) => {
          if (error || !data) {
            dispatch({ type: "ERROR", error: error ?? "joinRoom failed" })
            return
          }

          await device.load({ routerRtpCapabilities: data.rtpCapabilities as RTCRtpCapabilities })
          dispatch({ type: "CONNECTED", localStream })
          hasJoinedRef.current = true

          // If a presentation is already in progress, sync the slide state.
          if (data.currentSlide) {
            dispatch({ type: "SET_SLIDE", slide: data.currentSlide })
          }

          // Restore the shared whiteboard: if it's open for the room, mount it
          // with the latest persisted snapshot so we see the current drawing.
          dispatch({
            type: "SET_WHITEBOARD",
            open: !!data.whiteboardOpen,
            snapshot: data.whiteboardSnapshot ?? null,
          })

          // Load persisted chat history (oldest first). ADD_MESSAGE dedupes by
          // id, so re-running this on a full rejoin is harmless. "self" is
          // derived from our persistent peerId.
          if (Array.isArray(data.messages)) {
            for (const m of data.messages) {
              if (!m || typeof m.id !== "string" || typeof m.text !== "string") continue
              dispatch({
                type: "ADD_MESSAGE",
                message: {
                  id: m.id,
                  peerId: m.peerId,
                  displayName: m.displayName,
                  text: m.text,
                  timestamp: m.timestamp,
                  self: m.peerId === peerId.current,
                },
              })
            }
          }

          // Seed read markers so checkmarks on existing messages are correct
          // immediately (others may already have read our prior messages).
          if (Array.isArray(data.readMarkers)) {
            for (const r of data.readMarkers) {
              if (!r || typeof r.peerId !== "string" || typeof r.ts !== "number") continue
              dispatch({ type: "SET_READ_MARKER", peerId: r.peerId, ts: r.ts })
            }
          }

          for (const p of data.existingPeers) {
            dispatch({ type: "PEER_JOINED", peerId: p.peerId, displayName: p.displayName })
          }

          await setupTransports(socket, device, data.existingPeers)
        },
      )
    }

    socket.on("connect", async () => {
      // If this session was kicked (peerId opened elsewhere), never rejoin.
      if (kickedRef.current) {
        socket.disconnect()
        return
      }
      // -----------------------------------------------------------------------
      // RECONNECT path — socket.io re-established the signaling channel after a
      // transient network drop.
      //
      // Probe the server first. If the peer is still alive → ICE restart only.
      // If it was evicted (long drop) → full rejoin.
      // -----------------------------------------------------------------------
      if (hasJoinedRef.current) {
        socket.emit(
          "rejoinProbe",
          { roomId, peerId: peerId.current },
          async (error: string | null) => {
            if (!error) {
              restartIceForTransport(sendTransportRef.current)
              restartIceForTransport(recvTransportRef.current)
            } else {
              // Server evicted the peer (long network drop > pingTimeout).
              // Tear down all stale mediasoup state and do a full rejoin.
              // We keep the localStream tracks alive so the user does not need
              // to re-grant camera/mic permission — we just re-publish them.
              hasJoinedRef.current = false

              // Null out producer refs BEFORE closing transports so any
              // in-flight produce callbacks don't try to use a closed transport.
              const prevAudioProducer = audioProducerRef.current
              const prevVideoProducer = videoProducerRef.current
              audioProducerRef.current = null
              videoProducerRef.current = null
              screenVideoProducerRef.current = null
              screenAudioProducerRef.current = null

              prevAudioProducer?.close()
              prevVideoProducer?.close()

              sendTransportRef.current?.close()
              recvTransportRef.current?.close()
              sendTransportRef.current = null
              recvTransportRef.current = null
              consumersRef.current.clear()

              // Clear stale slide state — the fresh joinRoom response will
              // restore it if a presentation is still active.
              dispatch({ type: "SET_SLIDE", slide: null })

              // Re-run the join sequence. After setupTransports resolves the
              // new send transport is ready and we can re-publish the tracks that
              // the user had active before the drop.
              const hadMic = hasMicRef.current
              const wasUnmuted = !isMicMutedRef.current
              const hadCam = hasCamRef.current
              const wasCamOn = !isCamOffRef.current

              await doJoinSequence()

              // Re-publish active tracks on the NEW send transport.
              const newSendTransport = sendTransportRef.current
              if (!newSendTransport) return

              if (hadMic) {
                const audioTrack = localStreamRef.current?.getAudioTracks()[0]
                if (audioTrack) {
                  // Ensure track is enabled regardless of previous mute state —
                  // we'll pause the producer below if the user was muted.
                  audioTrack.enabled = true
                  const newAudioProducer = await (newSendTransport as ReturnType<DeviceType["createSendTransport"]>).produce({
                    track: audioTrack,
                    codecOptions: { opusFec: true, opusDtx: true },
                  })
                  audioProducerRef.current = newAudioProducer
                  if (!wasUnmuted) {
                    // Re-apply the muted state the user had before the drop.
                    audioTrack.enabled = false
                    newAudioProducer.pause()
                    socket.emit("pauseProducer", {
                      roomId,
                      peerId: peerId.current,
                      producerId: newAudioProducer.id,
                      paused: true,
                    })
                  }
                }
              }

              if (hadCam) {
                const videoTrack = localStreamRef.current?.getVideoTracks()[0]
                if (videoTrack) {
                  videoTrack.enabled = true
                  const newVideoProducer = await (newSendTransport as ReturnType<DeviceType["createSendTransport"]>).produce({
                    track: videoTrack,
                    ...CAMERA_PRODUCE_OPTIONS,
                  })
                  videoProducerRef.current = newVideoProducer
                  if (!wasCamOn) {
                    videoTrack.enabled = false
                    newVideoProducer.pause()
                  }
                }
              }
            }
          },
        )
        return
      }

      // -----------------------------------------------------------------------
      // FIRST CONNECT path.
      // -----------------------------------------------------------------------
      await doJoinSequence()
    })

    // Kicked because this same peerId connected from another tab/device.
    // The peerId is shared across tabs (persisted in localStorage), so the
    // NEW session takes over and this (older) one must stop cleanly.
    //
    // We MUST NOT reload/rejoin here — doing so would rejoin with the same
    // peerId, kick the new tab, which would reload and kick us back… an
    // infinite mutual-reconnection loop. Instead we tear everything down,
    // disable reconnection, and surface a clear message.
    socket.on("kicked", () => {
      kickedRef.current = true
      hasJoinedRef.current = false
      // Stop socket.io from auto-reconnecting after this disconnect.
      socket.io.opts.reconnection = false
      socket.disconnect()
      sendTransportRef.current?.close()
      recvTransportRef.current?.close()
      sendTransportRef.current = null
      recvTransportRef.current = null
      consumersRef.current.clear()
      dispatch({
        type: "ERROR",
        error: "Вы открыли эту комнату в другой вкладке или на другом устройстве. Здесь сеанс завершён.",
      })
    })

    // A peer joined the room (may not have produced media yet)
    socket.on("peerJoined", ({ peerId: joinedPeerId, displayName: joinedName }) => {
      dispatch({ type: "PEER_JOINED", peerId: joinedPeerId, displayName: joinedName })
      // Pleasant chime announcing someone entered the room.
      playJoinSound()
    })

    // New remote producer appeared
    socket.on("newProducer", async ({ peerId: remotePeerId, displayName: remoteName, producerId, kind, appData }) => {
      // The recv transport may not be ready yet (e.g. we got newProducer before
      // setupTransports finished). Poll with a hard timeout of 5 s (20 × 250 ms)
      // rather than an open-ended loop so we never leak a dangling callback.
      const waitForTransport = (): Promise<boolean> =>
        new Promise((resolve) => {
          if (recvTransportRef.current) { resolve(true); return }
          let attempts = 0
          const id = setInterval(() => {
            if (recvTransportRef.current) { clearInterval(id); resolve(true); return }
            if (++attempts >= 20) { clearInterval(id); resolve(false) }
          }, 250)
        })

      const ready = await waitForTransport()
      if (!ready) {
        console.warn("[useMediasoup] newProducer: recv transport not ready after 5s — skipping", producerId)
        return
      }
      await consumeProducer(remotePeerId, remoteName, producerId, kind as "audio" | "video", appData)
    })

    socket.on("peerLeft", ({ peerId: leftPeerId }) => {
      dispatch({ type: "PEER_LEFT", peerId: leftPeerId })
      // Soft descending chime announcing someone left the room.
      playLeaveSound()
    })

    // A remote producer was closed (e.g. peer stopped screen sharing)
    socket.on("producerClosed", ({ peerId: remotePeerId, producerId }) => {
      // Find the consumer tied to this producer to learn its kind/source
      let target: Consumer | undefined
      for (const c of consumersRef.current.values()) {
        if (c.producerId === producerId) {
          target = c
          break
        }
      }
      if (!target) {
        // The consumer for this producer hasn't been created yet (fast
        // start/stop). Remember it so consumeProducer can discard it on arrival.
        pendingClosedProducersRef.current.add(producerId)
        return
      }
      const rawSource = (target.appData as Record<string, unknown>)?.source
      const source: MediaSource =
        rawSource === "screen" ? "screen"
        : rawSource === "presentation" ? "presentation"
        : "media"
      const closedKind = target.kind as "audio" | "video"
      target.close()
      consumersRef.current.delete(target.id)
      dispatch({
        type: "PEER_PRODUCER_CLOSED",
        peerId: remotePeerId,
        source,
        kind: closedKind,
      })

      // A remote peer stopped a demonstration. Gate on the video track so we
      // play exactly one sound (a screen share's audio track also closes).
      if (closedKind === "video" && (source === "screen" || source === "presentation")) {
        playScreenShareStopSound()
      }
    })

    // -----------------------------------------------------------------------
    // Producer pause/resume — a remote peer muted/unmuted (or paused a track).
    // We only surface this for their microphone (media audio) so other peers
    // can show a "muted" indicator. Screen-share audio is ignored.
    // -----------------------------------------------------------------------
    socket.on(
      "producerPaused",
      ({ peerId: remotePeerId, producerId, paused }: { peerId: string; producerId: string; paused: boolean }) => {
        if (typeof remotePeerId !== "string" || typeof producerId !== "string") return
        // Resolve the consumer for this producer to confirm it's the peer's
        // microphone (media audio) and not screen-share audio.
        let target: Consumer | undefined
        for (const c of consumersRef.current.values()) {
          if (c.producerId === producerId) {
            target = c
            break
          }
        }
        if (!target || target.kind !== "audio") return
        const rawSource = (target.appData as Record<string, unknown>)?.source
        if (rawSource === "screen" || rawSource === "presentation") return
        dispatch({ type: "PEER_AUDIO_MUTED", peerId: remotePeerId, muted: !!paused })
      },
    )

    // -----------------------------------------------------------------------
    // Slide sync — server broadcasts these when the presenter changes slide
    // or stops presenting.
    // -----------------------------------------------------------------------
    socket.on(
      "presentationSlideChanged",
      ({ peerId: presenterPeerId, slide, total }: { peerId: string; slide: number; total: number }) => {
        // Basic sanity check — server already validates, but guard the reducer too.
        if (
          typeof presenterPeerId !== "string" || !presenterPeerId ||
          typeof slide !== "number" || !Number.isFinite(slide) || slide < 0 ||
          typeof total !== "number" || !Number.isFinite(total) || total < 1 ||
          slide >= total
        ) return
        dispatch({ type: "SET_SLIDE", slide: { peerId: presenterPeerId, slide: Math.floor(slide), total: Math.floor(total) } })
      },
    )

    socket.on(
      "presentationEnded",
      (_payload: { peerId: string }) => {
        dispatch({ type: "SET_SLIDE", slide: null })
      },
    )

    // -----------------------------------------------------------------------
    // Chat — a remote peer sent a message. The server only broadcasts to
    // OTHER peers, so anything arriving here is from someone else (self:false).
    // -----------------------------------------------------------------------
    socket.on(
      "chatMessage",
      (msg: { id: string; peerId: string; displayName: string; text: string; timestamp: number }) => {
        if (!msg || typeof msg.id !== "string" || typeof msg.text !== "string") return
        dispatch({
          type: "ADD_MESSAGE",
          message: {
            id: msg.id,
            peerId: msg.peerId,
            displayName: msg.displayName,
            text: msg.text,
            timestamp: msg.timestamp,
            self: false,
          },
        })
      },
    )

    // -----------------------------------------------------------------------
    // Chat read receipts — a remote peer advanced its read marker. We store it
    // so the local user's own messages can flip to "read".
    // -----------------------------------------------------------------------
    socket.on("chatRead", (payload: { peerId: string; ts: number }) => {
      if (!payload || typeof payload.peerId !== "string" || typeof payload.ts !== "number") return
      dispatch({ type: "SET_READ_MARKER", peerId: payload.peerId, ts: payload.ts })
    })

    // -----------------------------------------------------------------------
    // Shared whiteboard (tldraw)
    //
    // whiteboardOpened/Closed toggle the room-wide board for everyone. The
    // "opened" event carries the current snapshot so a peer who just turned the
    // board on locally and everyone else all converge on the same drawing.
    // whiteboardChange relays a remote peer's incremental store diff, which we
    // fan out to the mounted Whiteboard component via the listener registry.
    // -----------------------------------------------------------------------
    socket.on("whiteboardOpened", (payload: { peerId: string; snapshot: string | null }) => {
      dispatch({ type: "SET_WHITEBOARD", open: true, snapshot: payload?.snapshot ?? null })
    })

    socket.on("whiteboardClosed", () => {
      dispatch({ type: "SET_WHITEBOARD", open: false })
    })

    socket.on("whiteboardChange", (payload: { peerId: string; changes: unknown }) => {
      if (!payload || payload.changes == null) return
      whiteboardListenersRef.current.forEach((fn) => fn(payload.changes))
    })
  }, [roomId, displayName, setupTransports, consumeProducer])

  // -------------------------------------------------------------------------
  // Mobile / background recovery.
  //
  // The single biggest cause of "the phone user froze and never came back" is
  // that mobile browsers (especially iOS Safari) suspend JS timers, WebRTC and
  // websockets when the tab is backgrounded or the screen locks — and they do
  // NOT reliably fire socket.io's auto-reconnect when the app returns. We
  // listen for every signal that the app is alive again and proactively
  // recover: re-open the socket and renegotiate ICE so audio/video resume.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return

    const onVisible = () => {
      if (document.visibilityState === "visible") recoverConnection()
    }
    const onOnline = () => recoverConnection()
    const onFocus = () => recoverConnection()
    const onPageShow = () => recoverConnection()

    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", onOnline)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pageshow", onPageShow)

    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("online", onOnline)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [recoverConnection])

  // -------------------------------------------------------------------------
  // Leave
  // -------------------------------------------------------------------------
  // Stable ref so leave() can call stopPresentation() without a dep-cycle
  // (leave is declared before stopPresentation in the file).
  const stopPresentationRef = useRef<((options?: { silent?: boolean }) => void) | null>(null)

  const leave = useCallback(() => {
    // Stop any active presentation before leaving so canvas capture is released
    // and presentationEnded is sent to the server before the socket closes.
    // Silent: we're leaving the room, not ending a demonstration mid-call.
    stopPresentationRef.current?.({ silent: true })

    const socket = socketRef.current
    if (socket) {
      socket.emit("leaveRoom", { roomId, peerId: peerId.current })
      socket.disconnect()
      socketRef.current = null
    }
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null
    screenVideoProducerRef.current = null
    screenAudioProducerRef.current = null
    consumersRef.current.clear()
    // Reset join state so a subsequent join() (e.g. re-entering a room after
    // an intentional leave) follows the full first-connect path, not reconnect.
    hasJoinedRef.current = false
    iceRestartingRef.current.clear()
    // Clear any pending ICE-restart retry timers.
    iceRetryTimersRef.current.forEach((t) => clearTimeout(t))
    iceRetryTimersRef.current.clear()
    dispatch({ type: "DISCONNECTED" })
  }, [roomId])

  // -------------------------------------------------------------------------
  // Toggle mic — requests permission on first use
  // -------------------------------------------------------------------------
  const toggleMic = useCallback(async () => {
    const stream = localStreamRef.current
    const sendTransport = sendTransportRef.current
    if (!stream) return

    const existing = stream.getAudioTracks()[0]

    if (!existing) {
      // First time — ask for permission
      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedMicIdRef.current
            ? { deviceId: { exact: selectedMicIdRef.current } }
            : true,
        }
        const micStream = await navigator.mediaDevices.getUserMedia(constraints)
        const track = micStream.getAudioTracks()[0]
        stream.addTrack(track)
        if (sendTransport) {
          // Negotiate FEC + DTX with the router. FEC lets the receiver
          // reconstruct a lost packet from redundancy in the next packet —
          // critical on inter-city paths with 2–5 % loss. DTX cuts bitrate
          // during silence, reducing congestion-driven loss overall.
          const producer = await (sendTransport as ReturnType<DeviceType["createSendTransport"]>).produce({
            track,
            codecOptions: { opusFec: true, opusDtx: true },
          })
          audioProducerRef.current = producer
        }
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
      } catch {
        dispatch({ type: "ERROR", error: "Нет доступа к микрофону" })
      }
      return
    }

    // Already have track — just mute/unmute.
    // We both disable the local track AND pause the mediasoup producer.
    // Disabling the track alone is unreliable: the producer keeps sending RTP,
    // so remote peers can still hear you. Pausing the producer stops the flow
    // on the server side, guaranteeing silence when muted.
    const nextEnabled = !existing.enabled
    existing.enabled = nextEnabled

    const producer = audioProducerRef.current
    const socket = socketRef.current
    if (producer) {
      if (nextEnabled) {
        producer.resume()
      } else {
        producer.pause()
      }
      socket?.emit("pauseProducer", {
        roomId,
        peerId: peerId.current,
        producerId: producer.id,
        paused: !nextEnabled,
      })
    }

    dispatch({ type: "TOGGLE_MIC", isMuted: !nextEnabled })
  }, [roomId])

  // Switch to a different microphone device mid-call
  const switchMic = useCallback(async (deviceId: string) => {
    selectedMicIdRef.current = deviceId
    const stream = localStreamRef.current
    const sendTransport = sendTransportRef.current
    if (!stream) return

    // Replace existing audio track with the new device
    const oldTrack = stream.getAudioTracks()[0]
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      })
      const newTrack = micStream.getAudioTracks()[0]

      if (oldTrack) {
        oldTrack.stop()
        stream.removeTrack(oldTrack)
      }
      stream.addTrack(newTrack)

      const producer = audioProducerRef.current
      if (producer && sendTransport) {
        await producer.replaceTrack({ track: newTrack })
      } else if (!producer && sendTransport) {
        // Track was never published — publish now
        const newProducer = await (sendTransport as ReturnType<DeviceType["createSendTransport"]>).produce({ track: newTrack })
        audioProducerRef.current = newProducer
        dispatch({ type: "TOGGLE_MIC", isMuted: false, hasMic: true })
      }
    } catch {
      dispatch({ type: "ERROR", error: "Не удалось переключить микрофон" })
    }
  }, [])

  // -------------------------------------------------------------------------
  // Toggle cam — requests permission on first use
  // -------------------------------------------------------------------------
  const toggleCam = useCallback(async () => {
    const stream = localStreamRef.current
    const sendTransport = sendTransportRef.current
    if (!stream) return

    const existing = stream.getVideoTracks()[0]

    if (!existing) {
      // First time — ask for permission
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true })
        const track = camStream.getVideoTracks()[0]
        stream.addTrack(track)
        // Publish the track if transport is ready.
        // Camera uses simulcast so weak/remote receivers can drop to a lower
        // spatial layer instead of stalling the whole stream.
        if (sendTransport) {
          const producer = await sendTransport.produce({ track, ...CAMERA_PRODUCE_OPTIONS })
          videoProducerRef.current = producer
        }
        dispatch({ type: "TOGGLE_CAM", isOff: false, hasCam: true })
      } catch {
        dispatch({ type: "ERROR", error: "Нет доступа к камере" })
      }
      return
    }

    // Already have track — just show/hide
    existing.enabled = !existing.enabled
    dispatch({ type: "TOGGLE_CAM", isOff: !existing.enabled })
  }, [])

  // -------------------------------------------------------------------------
  // Screen sharing
  // -------------------------------------------------------------------------
  const stopScreenShare = useCallback((options?: { silent?: boolean }) => {
    const socket = socketRef.current
    // Whether a share was actually running, so we only play the "stopped" sound
    // for a genuine stop (not e.g. a no-op call or a quality-change restart).
    const wasSharing = !!screenVideoProducerRef.current

    for (const producer of [screenVideoProducerRef.current, screenAudioProducerRef.current]) {
      if (!producer) continue
      socket?.emit("closeProducer", {
        roomId,
        peerId: peerId.current,
        producerId: producer.id,
      })
      producer.close()
    }
    screenVideoProducerRef.current = null
    screenAudioProducerRef.current = null

    screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    screenStreamRef.current = null

    dispatch({ type: "SET_SCREEN_SHARING", isSharing: false })
    // Snappy descending arpeggio confirming screen sharing has stopped.
    if (wasSharing && !options?.silent) playScreenShareStopSound()
  }, [roomId])

  const startScreenShare = useCallback(async (options?: { silent?: boolean }) => {
    const sendTransport = sendTransportRef.current
    if (!sendTransport) return

    try {
      const preset = SCREEN_QUALITY_PRESETS[screenQualityRef.current]
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: preset.video,
        audio: true,
      })
      screenStreamRef.current = displayStream

      const videoTrack = displayStream.getVideoTracks()[0]
      const audioTrack = displayStream.getAudioTracks()[0]

      if (videoTrack) {
        // Hint the encoder to optimise for sharp text/detail rather than
        // smooth motion — important for sharing documents, code, slides.
        if ("contentHint" in videoTrack) {
          videoTrack.contentHint = "detail"
        }
        // Fixed-quality presets pin the resolution and bitrate; Auto lets
        // WebRTC adapt to bandwidth on its own but with a sensible floor/ceiling
        // and high network priority so the screen never collapses to a tiny
        // bitrate and recovers quickly after a dip.
        const encoding: RTCRtpEncodingParameters = preset.maxBitrate
          ? {
              maxBitrate: preset.maxBitrate,
              scaleResolutionDownBy: 1,
              // Screen share should win the bandwidth fight against the camera.
              networkPriority: "high",
              priority: "high",
            }
          : {
              // Auto: don't let the encoder starve the screen. Keep a healthy
              // ceiling and a floor so text stays legible, with high priority.
              maxBitrate: 4_000_000,
              scaleResolutionDownBy: 1,
              networkPriority: "high",
              priority: "high",
            }
        const producer = await sendTransport.produce({
          track: videoTrack,
          encodings: [encoding],
          codecOptions: {
            // Start high so the screen is sharp immediately instead of ramping
            // up from a blurry low-bitrate state, and allow a high ceiling.
            videoGoogleStartBitrate: preset.maxBitrate ? 2500 : 2000,
            videoGoogleMaxBitrate: preset.maxBitrate
              ? Math.round(preset.maxBitrate / 1000)
              : 4000,
            videoGoogleMinBitrate: 600,
          },
          appData: { source: "screen" },
        })
        screenVideoProducerRef.current = producer

        // Keep the shared screen SHARP over time. By default the encoder
        // prefers to maintain frame-rate and quietly drops resolution when
        // bandwidth dips — which makes text/slides progressively blurrier the
        // longer you share. For screen content we want the opposite: keep the
        // resolution crisp and sacrifice frame-rate instead. This is set on the
        // RTCRtpSender directly because it is a sender-level (not per-encoding)
        // preference.
        try {
          const sender = producer.rtpSender
          if (sender) {
            const params = sender.getParameters()
            // @ts-expect-error - degradationPreference is valid but missing in some TS DOM libs
            params.degradationPreference = "maintain-resolution"
            await sender.setParameters(params)
          }
        } catch {
          // Not all browsers expose degradationPreference; ignore if unsupported.
        }

        // User clicked the browser's native "Stop sharing" control
        videoTrack.onended = () => stopScreenShare()
      }

      if (audioTrack) {
        const producer = await sendTransport.produce({
          track: audioTrack,
          appData: { source: "screen" },
        })
        screenAudioProducerRef.current = producer

        // When the user switches output device mid-stream (e.g. plugs in
        // headphones while sharing), the browser may silently swap the capture
        // source. In Chrome the old audio track fires "ended"; in some versions
        // it simply goes silent. We listen for both signals and call
        // replaceScreenAudio() which hot-swaps only the audio track on the
        // existing producer — the video producer and all remote consumers are
        // untouched, so the stream keeps flowing without any gap.
        const replaceScreenAudio = async () => {
          const currentProducer = screenAudioProducerRef.current
          if (!currentProducer || currentProducer.closed) return
          // Screen share must still be active.
          if (!screenVideoProducerRef.current) return

          try {
            const freshStream = await navigator.mediaDevices.getDisplayMedia({
              audio: true,
              video: false,
            })
            const freshAudio = freshStream.getAudioTracks()[0]
            if (!freshAudio) { freshStream.getTracks().forEach((t) => t.stop()); return }

            await currentProducer.replaceTrack({ track: freshAudio })

            // Update our stream ref so the old track is properly stopped.
            const prevTrack = screenStreamRef.current?.getAudioTracks()[0]
            if (prevTrack && prevTrack !== freshAudio) {
              prevTrack.onended = null
              prevTrack.stop()
              screenStreamRef.current?.removeTrack(prevTrack)
            }
            screenStreamRef.current?.addTrack(freshAudio)

            // Watch the new track too.
            freshAudio.onended = replaceScreenAudio
          } catch {
            // User cancelled or permission denied — the existing stream continues.
          }
        }

        audioTrack.onended = replaceScreenAudio

        // Also catch the case where the browser doesn't fire "ended" but the
        // track goes silent because the capture device changed. The
        // "devicechange" event fires whenever an audio/video device is added or
        // removed — use it as a secondary trigger.
        const onDeviceChange = async () => {
          const currentAudio = screenStreamRef.current?.getAudioTracks()[0]
          // Only act if we still have an active screen share.
          if (!screenAudioProducerRef.current || screenAudioProducerRef.current.closed) {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            return
          }
          if (!currentAudio || currentAudio.readyState === "ended") {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            await replaceScreenAudio()
          }
        }
        navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)

        // Clean up the devicechange listener when the screen share stops.
        const origStop = stopScreenShare
        // We attach a one-time cleanup to the video track's onended instead of
        // wrapping stopScreenShare (which would create a circular dep). The
        // video track always ends when sharing stops.
        const prevVideoOnEnded = videoTrack?.onended ?? null
        if (videoTrack) {
          videoTrack.onended = () => {
            navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange)
            if (typeof prevVideoOnEnded === "function") prevVideoOnEnded.call(videoTrack)
            else origStop()
          }
        }
      }

      dispatch({ type: "SET_SCREEN_SHARING", isSharing: true })
      // Snappy ascending arpeggio confirming screen sharing has started.
      if (!options?.silent) playScreenShareSound()
    } catch {
      // User cancelled the picker or permission denied — silently ignore.
    }
  }, [stopScreenShare])

  const toggleScreenShare = useCallback(async () => {
    if (screenVideoProducerRef.current) {
      stopScreenShare()
    } else {
      await startScreenShare()
    }
  }, [startScreenShare, stopScreenShare])

  const setScreenQuality = useCallback(
    async (quality: ScreenQuality) => {
      screenQualityRef.current = quality
      setScreenQualityState(quality)
      // If a screen share is already running, restart it so the new preset
      // (resolution + bitrate) takes effect immediately.
      if (screenVideoProducerRef.current) {
        // Silent restart — it's the same share, not a stop/start the user did.
        stopScreenShare({ silent: true })
        await startScreenShare({ silent: true })
      }
    },
    [startScreenShare, stopScreenShare],
  )

  // -------------------------------------------------------------------------
  // Presentation sharing
  //
  // A presentation (PPTX / PDF / image) is rendered to a <canvas> by the
  // owner. We capture that canvas as a video track and publish it through the
  // normal send transport, tagged with appData.source === "presentation".
  // Every other peer receives it as a regular video stream and shows it in a
  // fullscreen overlay. Because only the owner controls the canvas (which
  // slide/scroll position), navigation is implicitly owner-only.
  // -------------------------------------------------------------------------
  const stopPresentation = useCallback((options?: { silent?: boolean }) => {
    const socket = socketRef.current
    const producer = presentationVideoProducerRef.current

    // Guard: nothing to tear down if no presentation is active.
    // Use isPresentingRef (not state) to avoid stale-closure issues in leave().
    if (!isPresentingRef.current && !producer && !presentationStreamRef.current) return
    const wasPresenting = isPresentingRef.current || !!producer
    isPresentingRef.current = false

    if (producer) {
      // Clear onended BEFORE stopping tracks so we don't trigger a recursive call.
      const track = presentationStreamRef.current?.getVideoTracks()[0]
      if (track) track.onended = null

      socket?.emit("closeProducer", {
        roomId,
        peerId: peerId.current,
        producerId: producer.id,
      })
      producer.close()
      presentationVideoProducerRef.current = null

      // Notify the server so it clears currentSlide and broadcasts to other peers.
      socket?.emit("presentationEnded", { roomId, peerId: peerId.current })
    }

    presentationStreamRef.current?.getTracks().forEach((t) => t.stop())
    presentationStreamRef.current = null
    dispatch({ type: "STOP_PRESENTING" })
    // Snappy descending arpeggio confirming the demonstration has stopped.
    if (wasPresenting && !options?.silent) playScreenShareStopSound()
  }, [roomId])

  // Wire the ref so leave() can call stopPresentation() without a dep-cycle.
  stopPresentationRef.current = stopPresentation

  // Notify the server (and all other peers) that the current slide changed.
  // Call this whenever the presenter navigates to a different slide/page.
  const notifySlideChange = useCallback((slide: number, total: number) => {
    const socket = socketRef.current
    if (!socket) return
    // Validate before emitting — mirrors server-side validation.
    if (
      !Number.isFinite(slide) || slide < 0 ||
      !Number.isFinite(total) || total < 1 ||
      Math.floor(slide) >= Math.floor(total)
    ) return
    const s = Math.floor(slide)
    const t = Math.floor(total)
    socket.emit("presentationSlide", { roomId, peerId: peerId.current, slide: s, total: t })
    // Update local state immediately so the presenter sees their own progress.
    dispatch({ type: "SET_SLIDE", slide: { peerId: peerId.current, slide: s, total: t } })
  }, [roomId])

  // Send a chat message: emit to the server (which broadcasts to other peers)
  // and add it locally right away so the sender sees it immediately.
  const sendChatMessage = useCallback((text: string) => {
    const trimmed = text.trim().slice(0, 2000)
    if (!trimmed) return
    const socket = socketRef.current
    if (!socket) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Send our generated id so the server persists + rebroadcasts with the same
    // id — that keeps our optimistic copy and the stored record in sync and
    // prevents duplicates when chat history is reloaded later.
    socket.emit("chatMessage", { roomId, peerId: peerId.current, text: trimmed, id })
    dispatch({
      type: "ADD_MESSAGE",
      message: {
        id,
        peerId: peerId.current,
        displayName,
        text: trimmed,
        timestamp: Date.now(),
        self: true,
      },
    })
  }, [roomId, displayName])

  // Report that the local user has read the chat up to `ts` (ms). Tells the
  // server (which broadcasts to others so their messages flip to "read") and
  // records our own marker locally for completeness.
  const markChatRead = useCallback((ts: number) => {
    if (!Number.isFinite(ts) || ts <= 0) return
    const socket = socketRef.current
    if (!socket) return
    socket.emit("chatRead", { roomId, peerId: peerId.current, ts })
    dispatch({ type: "SET_READ_MARKER", peerId: peerId.current, ts })
  }, [roomId])

  // -------------------------------------------------------------------------
  // Shared whiteboard senders + subscription.
  //
  // open/close flip the room-wide board for everyone (optimistic locally, the
  // server broadcasts to the others). sendWhiteboardChange relays an incremental
  // tldraw diff while drawing; sendWhiteboardSnapshot persists a full snapshot
  // (debounced by the Whiteboard component). subscribeWhiteboardChange lets the
  // canvas register for incoming remote diffs and returns an unsubscribe.
  // -------------------------------------------------------------------------
  const openWhiteboard = useCallback(() => {
    const socket = socketRef.current
    if (!socket) return
    socket.emit("whiteboardOpen", { roomId, peerId: peerId.current })
    dispatch({ type: "SET_WHITEBOARD", open: true })
  }, [roomId])

  const closeWhiteboard = useCallback(() => {
    const socket = socketRef.current
    if (!socket) return
    socket.emit("whiteboardClose", { roomId, peerId: peerId.current })
    dispatch({ type: "SET_WHITEBOARD", open: false })
  }, [roomId])

  const sendWhiteboardChange = useCallback((changes: unknown) => {
    const socket = socketRef.current
    if (!socket || changes == null) return
    socket.emit("whiteboardChange", { roomId, peerId: peerId.current, changes })
  }, [roomId])

  const sendWhiteboardSnapshot = useCallback((snapshot: string) => {
    const socket = socketRef.current
    if (!socket || typeof snapshot !== "string") return
    socket.emit("whiteboardSnapshot", { roomId, peerId: peerId.current, snapshot })
  }, [roomId])

  const subscribeWhiteboardChange = useCallback((fn: (changes: unknown) => void) => {
    whiteboardListenersRef.current.add(fn)
    return () => {
      whiteboardListenersRef.current.delete(fn)
    }
  }, [])

  // Publish a canvas-captured stream as the presentation video track.
  const startPresentation = useCallback(async (stream: MediaStream) => {
    const sendTransport = sendTransportRef.current
    if (!sendTransport) return

    // Tear down any existing presentation synchronously before producing a new
    // one. stopPresentation is synchronous (no awaits), so there is no race.
    stopPresentation()

    presentationStreamRef.current = stream
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) return

    // Optimise the encoder for sharp text/detail (slides, documents).
    if ("contentHint" in videoTrack) {
      videoTrack.contentHint = "detail"
    }

    const producer = await sendTransport.produce({
      track: videoTrack,
      encodings: [{ maxBitrate: 4_000_000, scaleResolutionDownBy: 1 }],
      codecOptions: { videoGoogleStartBitrate: 2000 },
      appData: { source: "presentation" },
    })
    presentationVideoProducerRef.current = producer
    isPresentingRef.current = true
    videoTrack.onended = () => stopPresentation()

    dispatch({ type: "SET_PRESENTING", isPresenting: true })
    // Snappy ascending arpeggio confirming the demonstration has started.
    playScreenShareSound()
  }, [stopPresentation])

  // -------------------------------------------------------------------------
  // Auto-join on mount, leave on unmount
  // -------------------------------------------------------------------------
  useEffect(() => {
    join()
    return () => {
      leave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    status: state.status,
    error: state.error,
    peers: state.peers,
    localStream: state.localStream,
    isMicMuted: state.isMicMuted,
    isCamOff: state.isCamOff,
    isScreenSharing: state.isScreenSharing,
    localScreenStream: screenStreamRef.current,
    hasMic: state.hasMic,
    hasCam: state.hasCam,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    screenQuality,
    setScreenQuality,
    switchMic,
    leave,
    // Presentation slide sync
    currentSlide: state.currentSlide,
    notifySlideChange,
    startPresentation,
    stopPresentation,
    isPresenting: state.isPresenting,
    // Chat
    messages: state.messages,
    sendChatMessage,
    // Read receipts
    readMarkers: state.readMarkers,
    markChatRead,
    // Shared whiteboard (tldraw)
    whiteboardOpen: state.whiteboardOpen,
    whiteboardSnapshot: state.whiteboardSnapshot,
    openWhiteboard,
    closeWhiteboard,
    sendWhiteboardChange,
    sendWhiteboardSnapshot,
    subscribeWhiteboardChange,
    localPeerId: peerId.current,
  }
}
