"use client"

import { useEffect, useRef, useCallback, useReducer } from "react"
import { io } from "socket.io-client"
import type { Socket } from "socket.io-client"
import { playJoinSound, playLeaveSound } from "@/lib/sounds"
import {
  SERVER_URL,
  getOrCreatePeerId,
  normalizeSource,
} from "@/hooks/mediasoup/types"
import type { ChatAttachment, ScreenQuality, Consumer, Transport, Producer, DeviceType, MediaSource } from "./mediasoup/types"

import { useTransports } from "./mediasoup/use-transports"
import { useMediaControls } from "./mediasoup/use-media-controls"
import { useWhiteboard } from "./mediasoup/use-whiteboard"
import { reducer } from "./mediasoup/reducer"
import { useChat } from "./mediasoup/use-chat"

export type { RemotePeer, RoomStatus, ScreenQuality, ChatAttachment, ChatMessage } from "./mediasoup/types"
export { SCREEN_QUALITY_PRESETS } from "./mediasoup/types"

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
    messages: [],
    readMarkers: {},
    whiteboardOpen: false,
    whiteboardSnapshot: null,
  })

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  const socketRef = useRef<Socket | null>(null)
  const deviceRef = useRef<DeviceType | null>(null)
  const sendTransportRef = useRef<Transport | null>(null)
  const recvTransportRef = useRef<Transport | null>(null)
  const peerIdRef = useRef<string>(getOrCreatePeerId())
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioProducerRef = useRef<Producer | null>(null)
  const videoProducerRef = useRef<Producer | null>(null)
  const screenVideoProducerRef = useRef<Producer | null>(null)
  const screenAudioProducerRef = useRef<Producer | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenQualityRef = useRef<ScreenQuality>("auto")
  const selectedMicIdRef = useRef<string | undefined>(undefined)
  const consumersRef = useRef<Map<string, Consumer>>(new Map())
  const pendingClosedProducersRef = useRef<Set<string>>(new Set())
  const hasJoinedRef = useRef(false)
  const kickedRef = useRef(false)
  const statusRef = useRef(state.status)
  const iceRestartingRef = useRef<Set<string>>(new Set())
  const iceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const isMicMutedRef = useRef(true)
  const hasMicRef = useRef(false)
  const isCamOffRef = useRef(true)
  const hasCamRef = useRef(false)
  const lastRecoverAtRef = useRef(0)

  // Keep refs in sync with state (readable inside async callbacks without stale closures)
  statusRef.current = state.status
  isMicMutedRef.current = state.isMicMuted
  hasMicRef.current = state.hasMic
  isCamOffRef.current = state.isCamOff
  hasCamRef.current = state.hasCam

  // ---------------------------------------------------------------------------
  // Sub-hooks
  // ---------------------------------------------------------------------------
  const transports = useTransports({
    roomId, peerIdRef, socketRef, deviceRef,
    sendTransportRef, recvTransportRef,
    consumersRef, pendingClosedProducersRef,
    iceRestartingRef, iceRetryTimersRef,
    audioProducerRef, videoProducerRef,
    screenVideoProducerRef, screenAudioProducerRef,
    dispatch,
  })

  const mediaControls = useMediaControls({
    roomId, peerIdRef, socketRef,
    sendTransportRef, localStreamRef,
    audioProducerRef, videoProducerRef,
    screenVideoProducerRef, screenAudioProducerRef,
    screenStreamRef, screenQualityRef, selectedMicIdRef,
    dispatch,
  })

  const chat = useChat({
    roomId, displayName, peerIdRef, socketRef, dispatch,
  })

  const whiteboard = useWhiteboard({
    roomId, peerIdRef, socketRef, dispatch,
  })

  // ---------------------------------------------------------------------------
  // Connection recovery (mobile / tab switch / VPN)
  // ---------------------------------------------------------------------------
  const recoverConnection = useCallback(() => {
    const socket = socketRef.current
    if (!socket || !hasJoinedRef.current) return
    if (!socket.connected) { socket.connect(); return }
    const now = Date.now()
    if (now - lastRecoverAtRef.current < 5000) return
    lastRecoverAtRef.current = now
    socket.emit("rejoinProbe", { roomId, peerId: peerIdRef.current },
      (error: string | null) => {
        if (!error) {
          transports.restartIceForTransport(sendTransportRef.current)
          transports.restartIceForTransport(recvTransportRef.current)
        }
      },
    )
  }, [roomId, peerIdRef, transports, sendTransportRef, recvTransportRef])

  // ---------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------
  const leave = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit("leaveRoom", { roomId, peerId: peerIdRef.current })
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
    hasJoinedRef.current = false
    iceRestartingRef.current.clear()
    iceRetryTimersRef.current.forEach((t) => clearTimeout(t))
    iceRetryTimersRef.current.clear()
    dispatch({ type: "DISCONNECTED" })
  }, [roomId, peerIdRef])

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------
  const join = useCallback(async () => {
    if (statusRef.current === "connecting" || statusRef.current === "connected") return
    dispatch({ type: "CONNECTING" })

    const localStream = new MediaStream()
    localStreamRef.current = localStream

    const socket = io(SERVER_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 10000,
    })
    socketRef.current = socket

    socket.on("connect_error", (e) => {
      if (!hasJoinedRef.current) {
        dispatch({ type: "ERROR", error: `Не удалось подключиться к серверу: ${e.message}` })
      }
    })

    // Core join sequence — called on first connect and on full rejoin
    const doJoinSequence = async () => {
      const { Device } = await import("mediasoup-client")
      const device = new Device()
      deviceRef.current = device

      socket.emit(
        "joinRoom",
        { roomId, peerId: peerIdRef.current, displayName, rtpCapabilities: {}, create },
        async (error: string | null, data: {
          rtpCapabilities: object
          existingPeers: Array<{
            peerId: string
            displayName: string
            producers: { producerId: string; kind: string; appData?: Record<string, unknown> }[]
          }>
          messages?: Array<{ id: string; peerId: string; displayName: string; text: string; timestamp: number; attachment?: ChatAttachment | null }>
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

          dispatch({
            type: "SET_WHITEBOARD",
            open: !!data.whiteboardOpen,
            snapshot: data.whiteboardSnapshot ?? null,
          })

          if (Array.isArray(data.messages)) {
            for (const m of data.messages) {
              if (!m || typeof m.id !== "string" || typeof m.text !== "string") continue
              dispatch({
                type: "ADD_MESSAGE",
                message: {
                  id: m.id, peerId: m.peerId, displayName: m.displayName,
                  text: m.text, timestamp: m.timestamp,
                  self: m.peerId === peerIdRef.current,
                  attachment: m.attachment ?? null,
                },
              })
            }
          }

          if (Array.isArray(data.readMarkers)) {
            for (const r of data.readMarkers) {
              if (r?.peerId && typeof r.ts === "number") {
                dispatch({ type: "SET_READ_MARKER", peerId: r.peerId, ts: r.ts })
              }
            }
          }

          await transports.setupTransports(socket, device, data.existingPeers)

          // Catch-up publish: re-publish any tracks the user had active before a rejoin
          const newSendTransport = sendTransportRef.current
          if (!newSendTransport) return

          if (hasMicRef.current && !audioProducerRef.current) {
            const audioTrack = localStreamRef.current?.getAudioTracks()[0]
            if (audioTrack) {
              audioTrack.enabled = true
              const producer = await newSendTransport.produce({
                track: audioTrack,
                codecOptions: { opusFec: true, opusDtx: true },
              })
              audioProducerRef.current = producer
              if (isMicMutedRef.current) {
                audioTrack.enabled = false
                producer.pause()
                socket.emit("pauseProducer", {
                  roomId, peerId: peerIdRef.current, producerId: producer.id, paused: true,
                })
              }
            }
          }

          if (hasCamRef.current && !videoProducerRef.current) {
            const videoTrack = localStreamRef.current?.getVideoTracks()[0]
            if (videoTrack) {
              const { CAMERA_PRODUCE_OPTIONS } = await import("./mediasoup/types")
              const producer = await newSendTransport.produce({ track: videoTrack, ...CAMERA_PRODUCE_OPTIONS })
              videoProducerRef.current = producer
              if (isCamOffRef.current) {
                videoTrack.enabled = false
                producer.pause()
              }
            }
          }
        },
      )
    }

    // ---------------------------------------------------------------------------
    // Socket event listeners
    // ---------------------------------------------------------------------------
    socket.on("connect", async () => {
      if (!hasJoinedRef.current) {
        await doJoinSequence()
        return
      }

      // Reconnect path: probe server, ICE restart or full rejoin
      socket.emit("rejoinProbe", { roomId, peerId: peerIdRef.current },
        async (error: string | null) => {
          if (!error) {
            transports.restartIceForTransport(sendTransportRef.current)
            transports.restartIceForTransport(recvTransportRef.current)
          } else {
            // Full rejoin: server evicted the peer
            hasJoinedRef.current = false

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

            await doJoinSequence()
          }
        },
      )
    })

    socket.on("kicked", () => {
      kickedRef.current = true
      hasJoinedRef.current = false
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

    socket.on("peerJoined", ({ peerId: joinedId, displayName: joinedName }) => {
      dispatch({ type: "PEER_JOINED", peerId: joinedId, displayName: joinedName })
      playJoinSound()
    })

    socket.on("newProducer", async ({ peerId: remotePeerId, displayName: remoteName, producerId, kind, appData }) => {
      const waitForTransport = (): Promise<boolean> =>
        new Promise((resolve) => {
          if (recvTransportRef.current) { resolve(true); return }
          let attempts = 0
          const id = setInterval(() => {
            if (recvTransportRef.current) { clearInterval(id); resolve(true); return }
            if (++attempts >= 60) { clearInterval(id); resolve(false) }
          }, 250)
        })
      const ready = await waitForTransport()
      if (!ready) return
      await transports.consumeProducer(remotePeerId, remoteName, producerId, kind as "audio" | "video", appData)
    })

    socket.on("peerLeft", ({ peerId: leftId }) => {
      dispatch({ type: "PEER_LEFT", peerId: leftId })
      playLeaveSound()
    })

    socket.on("producerClosed", ({ peerId: remotePeerId, producerId }) => {
      let target: Consumer | undefined
      for (const c of consumersRef.current.values()) {
        if (c.producerId === producerId) { target = c; break }
      }
      if (!target) {
        pendingClosedProducersRef.current.add(producerId)
        return
      }
      const source: MediaSource = normalizeSource((target.appData as Record<string, unknown>)?.source)
      target.close()
      consumersRef.current.delete(target.id)
      dispatch({ type: "PEER_PRODUCER_CLOSED", peerId: remotePeerId, source, kind: target.kind })
    })

    socket.on("producerPaused", ({ peerId: remotePeerId, producerId, paused }: { peerId: string; producerId: string; paused: boolean }) => {
      if (typeof remotePeerId !== "string") return
      let target: Consumer | undefined
      for (const c of consumersRef.current.values()) {
        if (c.producerId === producerId) { target = c; break }
      }
      if (!target || target.kind !== "audio") return
      if ((target.appData as Record<string, unknown>)?.source === "screen") return
      dispatch({ type: "PEER_AUDIO_MUTED", peerId: remotePeerId, muted: !!paused })
    })

    socket.on("chatMessage", (msg: { id: string; peerId: string; displayName: string; text: string; timestamp: number; attachment?: ChatAttachment | null }) => {
      if (!msg || typeof msg.id !== "string") return
      dispatch({ type: "ADD_MESSAGE", message: { ...msg, self: false, attachment: msg.attachment ?? null } })
    })

    socket.on("chatRead", (payload: { peerId: string; ts: number }) => {
      if (!payload || typeof payload.peerId !== "string" || typeof payload.ts !== "number") return
      dispatch({ type: "SET_READ_MARKER", peerId: payload.peerId, ts: payload.ts })
    })

    socket.on("whiteboardOpened", (payload: { peerId: string; snapshot: string | null }) => {
      dispatch({ type: "SET_WHITEBOARD", open: true, snapshot: payload?.snapshot ?? null })
    })
    socket.on("whiteboardClosed", () => {
      dispatch({ type: "SET_WHITEBOARD", open: false })
    })
    socket.on("whiteboardChange", (payload: { peerId: string; changes: unknown }) => {
      if (!payload || payload.changes == null) return
      whiteboard.whiteboardListenersRef.current.forEach((fn) => fn(payload.changes))
    })
    socket.on("annotationStroke", (payload: { peerId: string; stroke: unknown }) => {
      if (!payload || payload.stroke == null) return
      whiteboard.annotationStrokeListenersRef.current.forEach((fn) => fn(payload.stroke))
    })
    socket.on("annotationClear", () => {
      whiteboard.annotationClearListenersRef.current.forEach((fn) => fn())
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, displayName, create])

  // ---------------------------------------------------------------------------
  // Auto-join on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    join()
    return () => { leave() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------
  return {
    // Status
    status: state.status,
    error: state.error,
    permissionError: mediaControls.permissionError,
    clearPermissionError: mediaControls.clearPermissionError,
    localPeerId: peerIdRef.current,
    // Peers & streams
    peers: state.peers,
    localStream: state.localStream,
    localScreenStream: screenStreamRef.current,
    // Media state
    isMicMuted: state.isMicMuted,
    isCamOff: state.isCamOff,
    isScreenSharing: state.isScreenSharing,
    hasMic: state.hasMic,
    hasCam: state.hasCam,
    // Media controls
    toggleMic: mediaControls.toggleMic,
    toggleCam: mediaControls.toggleCam,
    toggleScreenShare: mediaControls.toggleScreenShare,
    switchMic: mediaControls.switchMic,
    screenQuality: mediaControls.screenQuality,
    setScreenQuality: mediaControls.setScreenQuality,
    // Connection
    leave,
    recoverConnection,
    // Chat
    messages: state.messages,
    sendChatMessage: chat.sendChatMessage,
    uploadChatFile: chat.uploadChatFile,
    markChatRead: chat.markChatRead,
    readMarkers: state.readMarkers,
    mediaBaseUrl: SERVER_URL,
    // Whiteboard
    whiteboardOpen: state.whiteboardOpen,
    whiteboardSnapshot: state.whiteboardSnapshot,
    openWhiteboard: whiteboard.openWhiteboard,
    closeWhiteboard: whiteboard.closeWhiteboard,
    sendWhiteboardChange: whiteboard.sendWhiteboardChange,
    sendWhiteboardSnapshot: whiteboard.sendWhiteboardSnapshot,
    subscribeWhiteboardChange: whiteboard.subscribeWhiteboardChange,
    // Annotations
    sendAnnotationStroke: whiteboard.sendAnnotationStroke,
    sendAnnotationClear: whiteboard.sendAnnotationClear,
    subscribeAnnotationStroke: whiteboard.subscribeAnnotationStroke,
    subscribeAnnotationClear: whiteboard.subscribeAnnotationClear,
  }
}
