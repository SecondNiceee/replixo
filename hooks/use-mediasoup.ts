"use client"

import { useEffect, useRef, useCallback, useReducer, useState } from "react"
import { io, Socket } from "socket.io-client"
import { Device } from "mediasoup-client"
import type { Transport, Producer, Consumer } from "mediasoup-client/lib/types"

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

interface State {
  status: RoomStatus
  error: string | null
  peers: Map<string, RemotePeer>
  localStream: MediaStream | null
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  // whether the user has ever enabled mic/cam (i.e. track exists)
  hasMic: boolean
  hasCam: boolean
}

type Action =
  | { type: "CONNECTING" }
  | { type: "CONNECTED"; localStream: MediaStream }
  | { type: "ERROR"; error: string }
  | { type: "DISCONNECTED" }
  | { type: "PEER_JOINED"; peerId: string; displayName: string }
  | { type: "PEER_STREAM"; peerId: string; displayName: string; kind: "video" | "audio"; source: "media" | "screen"; stream: MediaStream }
  | { type: "PEER_PRODUCER_CLOSED"; peerId: string; source: "media" | "screen"; kind: "video" | "audio" }
  | { type: "PEER_LEFT"; peerId: string }
  | { type: "TOGGLE_MIC"; isMuted: boolean; hasMic?: boolean }
  | { type: "TOGGLE_CAM"; isOff: boolean; hasCam?: boolean }
  | { type: "SET_SCREEN_SHARING"; isSharing: boolean }

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
      const key =
        action.source === "screen"
          ? action.kind === "video"
            ? "screenStream"
            : "screenAudioStream"
          : action.kind === "video"
            ? "videoStream"
            : "audioStream"
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
      const key =
        action.source === "screen"
          ? action.kind === "video"
            ? "screenStream"
            : "screenAudioStream"
          : action.kind === "video"
            ? "videoStream"
            : "audioStream"
      const updated = { ...existing }
      delete updated[key]
      peers.set(action.peerId, updated)
      return { ...state, peers }
    }
    case "PEER_LEFT": {
      const peers = new Map(state.peers)
      peers.delete(action.peerId)
      return { ...state, peers }
    }
    case "TOGGLE_MIC":
      return { ...state, isMicMuted: action.isMuted, hasMic: action.hasMic ?? state.hasMic }
    case "TOGGLE_CAM":
      return { ...state, isCamOff: action.isOff, hasCam: action.hasCam ?? state.hasCam }
    case "SET_SCREEN_SHARING":
      return { ...state, isScreenSharing: action.isSharing }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_URL =
  process.env.NEXT_PUBLIC_MEDIASOUP_URL ?? "http://localhost:3001"

function generatePeerId(): string {
  return Math.random().toString(36).slice(2, 10)
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
    hasMic: false,
    hasCam: false,
  })

  const socketRef = useRef<Socket | null>(null)
  const deviceRef = useRef<Device | null>(null)
  const sendTransportRef = useRef<Transport | null>(null)
  const recvTransportRef = useRef<Transport | null>(null)
  const peerId = useRef<string>(generatePeerId())
  const localStreamRef = useRef<MediaStream | null>(null)
  const videoProducerRef = useRef<Producer | null>(null)
  const audioProducerRef = useRef<Producer | null>(null)
  const screenVideoProducerRef = useRef<Producer | null>(null)
  const screenAudioProducerRef = useRef<Producer | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const selectedMicIdRef = useRef<string | undefined>(undefined)
  // currently selected screen-share quality preset
  const screenQualityRef = useRef<ScreenQuality>("auto")
  const [screenQuality, setScreenQualityState] = useState<ScreenQuality>("auto")
  // consumerId -> Consumer
  const consumersRef = useRef<Map<string, Consumer>>(new Map())
  // producerIds that were closed before we finished consuming them (race guard)
  const pendingClosedProducersRef = useRef<Set<string>>(new Set())
  // whether an initial join has completed. Distinguishes a first connect from
  // a socket.io reconnection after a transient network drop.
  const hasJoinedRef = useRef(false)
  // guards against firing several overlapping ICE restarts for one transport
  const iceRestartingRef = useRef<Set<string>>(new Set())

  // -------------------------------------------------------------------------
  // Restart ICE on a transport whose network path broke (transient drop / VPN
  // switch). The transport, its producers and consumers all stay alive — only
  // the ICE candidates are renegotiated, so media resumes without re-creating
  // anything and the peer never leaves the room.
  // -------------------------------------------------------------------------
  const restartIceForTransport = useCallback(
    (transport: Transport | null) => {
      const socket = socketRef.current
      if (!socket || !transport || transport.closed) return
      if (iceRestartingRef.current.has(transport.id)) return
      iceRestartingRef.current.add(transport.id)

      socket.emit(
        "restartIce",
        { roomId, peerId: peerId.current, transportId: transport.id },
        async (error: string | null, iceParameters: object | undefined) => {
          iceRestartingRef.current.delete(transport.id)
          if (error || !iceParameters) {
            console.error("[useMediasoup] restartIce error:", error)
            return
          }
          try {
            await transport.restartIce({ iceParameters: iceParameters as RTCIceParameters })
          } catch (e) {
            console.error("[useMediasoup] transport.restartIce failed:", e)
          }
        },
      )
    },
    [roomId],
  )

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

          const source =
            (appData?.source ?? (data.appData as Record<string, unknown>)?.source) === "screen"
              ? "screen"
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
      device: Device,
      direction: "send" | "recv",
    ): Promise<ReturnType<Device["createSendTransport"]> | ReturnType<Device["createRecvTransport"]>> => {
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
            // VPN toggle), WebRTC reports "disconnected" then "failed". Instead
            // of tearing the call down, renegotiate ICE so media resumes on the
            // new network path. The peer stays in the room the whole time.
            transport.on("connectionstatechange", (connectionState) => {
              if (connectionState === "disconnected" || connectionState === "failed") {
                restartIceForTransport(transport as Transport)
              }
            })

            if (direction === "send") {
              (transport as ReturnType<Device["createSendTransport"]>).on(
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
      device: Device,
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

      sendTransportRef.current = sendTransport as ReturnType<Device["createSendTransport"]>
      recvTransportRef.current = recvTransport as ReturnType<Device["createRecvTransport"]>

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
    if (state.status === "connecting" || state.status === "connected") return

    dispatch({ type: "CONNECTING" })

    // Join without requesting camera/mic — user will enable them manually
    const localStream = new MediaStream()
    localStreamRef.current = localStream

    const socket = io(SERVER_URL, {
      transports: ["websocket"],
      // Keep reconnecting indefinitely with short delays so a ~1-second network
      // blip re-establishes the signaling channel quickly. The server's
      // pingTimeout (30 s) ensures the peer is not evicted during this window.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
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

    socket.on("connect", async () => {
      // -----------------------------------------------------------------------
      // RECONNECT path — socket.io re-established the signaling channel after a
      // transient network drop. The mediasoup session (Device, transports,
      // producers, consumers) is still intact on the server because the peer
      // was NOT removed (pingTimeout keeps it alive for ~30 s). All we need to
      // do is re-negotiate ICE on both transports so RTP can flow again.
      // -----------------------------------------------------------------------
      if (hasJoinedRef.current) {
        restartIceForTransport(sendTransportRef.current)
        restartIceForTransport(recvTransportRef.current)
        return
      }

      // -----------------------------------------------------------------------
      // FIRST CONNECT path — normal join sequence.
      // -----------------------------------------------------------------------
      const device = new Device()
      deviceRef.current = device

      // First call joinRoom to get router RTP capabilities, then load device
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
        } | undefined) => {
          if (error || !data) {
            dispatch({ type: "ERROR", error: error ?? "joinRoom failed" })
            return
          }

          // Load device with router capabilities BEFORE creating transports
          await device.load({ routerRtpCapabilities: data.rtpCapabilities as RTCRtpCapabilities })

          dispatch({ type: "CONNECTED", localStream })

          // Mark as joined so reconnects follow the ICE-restart path above.
          hasJoinedRef.current = true

          // Register existing peers immediately so the participant count is
          // accurate even before any of them produce media.
          for (const p of data.existingPeers) {
            dispatch({ type: "PEER_JOINED", peerId: p.peerId, displayName: p.displayName })
          }

          // setupTransports uses device.rtpCapabilities which are now populated
          await setupTransports(socket, device, data.existingPeers)
        },
      )
    })

    // A peer joined the room (may not have produced media yet)
    socket.on("peerJoined", ({ peerId: joinedPeerId, displayName: joinedName }) => {
      dispatch({ type: "PEER_JOINED", peerId: joinedPeerId, displayName: joinedName })
    })

    // New remote producer appeared
    socket.on("newProducer", async ({ peerId: remotePeerId, displayName: remoteName, producerId, kind, appData }) => {
      // Wait briefly for recv transport to be ready
      let attempts = 0
      const waitAndConsume = async () => {
        if (!recvTransportRef.current) {
          if (attempts++ < 20) {
            setTimeout(waitAndConsume, 250)
          }
          return
        }
        await consumeProducer(remotePeerId, remoteName, producerId, kind as "audio" | "video", appData)
      }
      await waitAndConsume()
    })

    socket.on("peerLeft", ({ peerId: leftPeerId }) => {
      dispatch({ type: "PEER_LEFT", peerId: leftPeerId })
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
      const source = (target.appData as Record<string, unknown>)?.source === "screen" ? "screen" : "media"
      target.close()
      consumersRef.current.delete(target.id)
      dispatch({
        type: "PEER_PRODUCER_CLOSED",
        peerId: remotePeerId,
        source,
        kind: target.kind as "audio" | "video",
      })
    })
  }, [roomId, displayName, state.status, setupTransports, consumeProducer])

  // -------------------------------------------------------------------------
  // Leave
  // -------------------------------------------------------------------------
  const leave = useCallback(() => {
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
          const producer = await (sendTransport as ReturnType<Device["createSendTransport"]>).produce({ track })
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
        const newProducer = await (sendTransport as ReturnType<Device["createSendTransport"]>).produce({ track: newTrack })
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
        // Publish the track if transport is ready
        if (sendTransport) {
          const producer = await sendTransport.produce({ track })
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
  const stopScreenShare = useCallback(() => {
    const socket = socketRef.current

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
  }, [roomId])

  const startScreenShare = useCallback(async () => {
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
        // WebRTC adapt to bandwidth on its own.
        const encoding: RTCRtpEncodingParameters = preset.maxBitrate
          ? { maxBitrate: preset.maxBitrate, scaleResolutionDownBy: 1 }
          : {}
        const producer = await sendTransport.produce({
          track: videoTrack,
          encodings: [encoding],
          codecOptions: {
            videoGoogleStartBitrate: preset.maxBitrate ? 2000 : 1000,
          },
          appData: { source: "screen" },
        })
        screenVideoProducerRef.current = producer
        // User clicked the browser's native "Stop sharing" control
        videoTrack.onended = () => stopScreenShare()
      }

      if (audioTrack) {
        const producer = await sendTransport.produce({
          track: audioTrack,
          appData: { source: "screen" },
        })
        screenAudioProducerRef.current = producer
      }

      dispatch({ type: "SET_SCREEN_SHARING", isSharing: true })
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
        stopScreenShare()
        await startScreenShare()
      }
    },
    [startScreenShare, stopScreenShare],
  )

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
  }
}
