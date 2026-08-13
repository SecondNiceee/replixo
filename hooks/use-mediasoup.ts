"use client"

import { captureMic, releaseMicTrack, diagnoseMicTrack } from "@/lib/mic-gate"

import { useEffect, useRef, useCallback, useReducer } from "react"
import { io } from "socket.io-client"
import type { Socket } from "socket.io-client"
import {
  SERVER_URL,
  CLIENT_ID,
  getOrCreatePeerId,
} from "@/hooks/mediasoup/types"
import type { ChatAttachment, ScreenQuality, Consumer, Transport, Producer, DeviceType } from "./mediasoup/types"

import { useTransports } from "./mediasoup/use-transports"
import { useMediaControls } from "./mediasoup/use-media-controls"
import { useNetworkGuard } from "./mediasoup/use-network-guard"
import { useWhiteboard } from "./mediasoup/use-whiteboard"
import { reducer } from "./mediasoup/reducer"
import { useChat } from "./mediasoup/use-chat"
import { registerRoomSocketListeners } from "./mediasoup/register-socket-listeners"

export type { RemotePeer, RoomStatus, ScreenQuality, ChatAttachment, ChatMessage } from "./mediasoup/types"
export { SCREEN_QUALITY_PRESETS } from "./mediasoup/types"

// Minimum gap between two full media-session rebuilds. A rebuild is visible to
// every other participant (producers close and re-open), so it must never turn
// into a loop on a flaky network.
const REBUILD_COOLDOWN_MS = 30000

// How long to wait for the server's joinRoom acknowledgement before giving up.
// Generous enough for a cold room (mediasoup router creation + chat history) on
// a slow link, but finite — an unanswered join must surface as an error rather
// than an endless "Подключение к комнате".
const JOIN_ACK_TIMEOUT_MS = 15000

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
  // Derived from a persistent device id + the room, so reopening the room in
  // another tab reuses this identity (the server then kicks the stale session)
  // instead of creating a second "clone" participant.
  const peerIdRef = useRef<string>(getOrCreatePeerId(roomId))
  const peerIdRoomRef = useRef<string>(roomId)
  if (peerIdRoomRef.current !== roomId) {
    peerIdRoomRef.current = roomId
    peerIdRef.current = getOrCreatePeerId(roomId)
  }
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
  // Serialises EVERY microphone publish (button, device switch, recovery, and the
  // join / rejoin catch-up below). `!audioProducerRef.current` is not a lock:
  // `produce()` is async, so clicking the mic during a join used to create a
  // second, orphaned producer that no mute ever reached.
  const audioPublishInFlightRef = useRef(false)
  const isCamOffRef = useRef(true)
  const hasCamRef = useRef(false)
  const lastRecoverAtRef = useRef(0)
  const joinInFlightRef = useRef(false)
  const connectionGenerationRef = useRef(0)
  const recoveryInFlightRef = useRef(false)
  const lastRebuildAtRef = useRef(0)
  const rebuildConnectionRef = useRef<(reason: string) => Promise<void>>(async () => {})
  // Set by the weak-network guard. Read by useTransports so an ICE-recovery
  // resume sweep (or a brand new consumer) can't undo a downlink decision.
  const videoConsumersSuppressedRef = useRef(false)
  // Indirection: media controls are created before the guard, but the camera
  // button has to be able to tell the guard "the user wants video".
  const noteUserWantsVideoRef = useRef<() => void>(() => {})

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
    videoConsumersSuppressedRef,
    onRecoveryExhausted: (reason) => { void rebuildConnectionRef.current(`ice-${reason}`) },
    dispatch,
  })

  const mediaControls = useMediaControls({
    roomId, peerIdRef, socketRef,
    sendTransportRef, localStreamRef,
    audioProducerRef, videoProducerRef,
    screenVideoProducerRef, screenAudioProducerRef,
    screenStreamRef, screenQualityRef, selectedMicIdRef,
    isCamOffRef,
    isMicMutedRef,
    audioPublishInFlightRef,
    hasJoinedRef,
    onUserWantsVideo: () => { noteUserWantsVideoRef.current() },
    dispatch,
  })

  // Keeps the voice alive on a bad link by degrading — and finally dropping —
  // video in whichever direction is actually failing.
  const networkGuard = useNetworkGuard({
    roomId, peerIdRef, socketRef,
    sendTransportRef, recvTransportRef,
    audioProducerRef, videoProducerRef, screenVideoProducerRef,
    localStreamRef, consumersRef,
    videoConsumersSuppressedRef,
    isCamOffRef, hasJoinedRef,
  })
  noteUserWantsVideoRef.current = networkGuard.noteUserWantsVideo

  const chat = useChat({
    roomId, displayName, peerIdRef, socketRef, dispatch,
  })

  const whiteboard = useWhiteboard({
    roomId, peerIdRef, socketRef, dispatch,
  })

  // ---------------------------------------------------------------------------
  // Connection recovery (mobile / tab switch / VPN)
  //
  // IMPORTANT: recovery is *evidence-based*. Simply switching to another browser
  // tab and coming back does not break anything on desktop — the socket stays
  // connected, ICE stays connected and the capture tracks stay live. The old
  // code nonetheless ran the full heavy repair on every `visibilitychange`
  // (ICE restart on BOTH transports + camera republish + screen republish),
  // which is exactly what made the camera go black and killed a running screen
  // share a couple of seconds after returning to the tab.
  //
  // So we first look at what is actually broken and only repair that. When the
  // session is healthy we do nothing at all.
  // ---------------------------------------------------------------------------
  const isTransportBroken = useCallback((transport: Transport | null) => {
    if (!transport) return true
    if (transport.closed) return true
    const state = transport.connectionState
    return state === "disconnected" || state === "failed" || state === "closed"
  }, [])

  const assessSession = useCallback(() => {
    const sendTransport = sendTransportRef.current
    const sendBroken = isTransportBroken(sendTransport)
    const recvBroken = isTransportBroken(recvTransportRef.current)

    // Microphone: audio was missing from this assessment entirely, which is why
    // a silent microphone used to survive every repair path and last until the
    // user rejoined the room. `diagnoseMicTrack` sees through the noise gate (a
    // gate's output track is always "live" and never "muted", so it hides device
    // loss, device mutes and a dead WebAudio graph).
    const micTrack = localStreamRef.current?.getAudioTracks()[0] ?? null
    const micProducer = audioProducerRef.current
    const micExpected = !!micTrack || !!micProducer
    const micBroken = micExpected && (
      diagnoseMicTrack(micTrack) !== null ||
      !micProducer ||
      micProducer.closed ||
      (!!sendTransport && micProducer.transport !== sendTransport)
    )

    // Camera: only "broken" when a camera is supposed to be running and either
    // the capture track died or its producer no longer belongs to the current
    // send transport.
    const camTrack = localStreamRef.current?.getVideoTracks()[0] ?? null
    const camProducer = videoProducerRef.current
    const camExpected = !!camTrack || !!camProducer
    const camBroken = camExpected && (
      !camTrack ||
      camTrack.readyState === "ended" ||
      !camProducer ||
      camProducer.closed ||
      (!!sendTransport && camProducer.transport !== sendTransport)
    )

    // Screen share: same idea. A live capture track with a live producer on the
    // current transport must never be touched.
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0] ?? null
    const screenProducer = screenVideoProducerRef.current
    const screenExpected = !!screenStreamRef.current || !!screenProducer
    const screenBroken = screenExpected && (
      !screenTrack ||
      screenTrack.readyState === "ended" ||
      !screenProducer ||
      screenProducer.closed ||
      (!!sendTransport && screenProducer.transport !== sendTransport)
    )

    return {
      sendBroken,
      recvBroken,
      micBroken,
      camBroken,
      screenBroken,
      healthy: !sendBroken && !recvBroken && !micBroken && !camBroken && !screenBroken,
    }
  }, [isTransportBroken])

  const recoverConnection = useCallback((options?: { force?: boolean }) => {
    const socket = socketRef.current
    if (!socket || !hasJoinedRef.current) return
    if (!socket.connected) { socket.connect(); return }

    const assessment = assessSession()
    // Nothing is wrong — a plain tab switch, window focus or bfcache restore.
    // Touching the transports here is strictly harmful.
    if (assessment.healthy && !options?.force) return

    const now = Date.now()
    if (now - lastRecoverAtRef.current < 5000 || recoveryInFlightRef.current) return
    lastRecoverAtRef.current = now
    recoveryInFlightRef.current = true
    const generation = connectionGenerationRef.current
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      recoveryInFlightRef.current = false
      void rebuildConnectionRef.current("manual-probe-timeout")
    }, 8000)
    socket.emit("rejoinProbe", { roomId, peerId: peerIdRef.current, clientId: CLIENT_ID }, (error: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      recoveryInFlightRef.current = false
      if (socketRef.current !== socket || connectionGenerationRef.current !== generation) return
      if (error) {
        void rebuildConnectionRef.current(`manual-probe-rejected:${error}`)
        return
      }
      // Re-assess: the probe round-trip takes a moment and things may have
      // healed on their own (ICE often reconnects by itself).
      const current = assessSession()
      if (current.sendBroken) transports.restartIceForTransport(sendTransportRef.current)
      if (current.recvBroken) transports.restartIceForTransport(recvTransportRef.current)
      if (current.micBroken) void mediaControls.recoverMic("manual-probe")
      if (current.camBroken) void mediaControls.recoverCamera()
      if (current.screenBroken) {
        window.setTimeout(() => { void mediaControls.recoverScreenShare() }, 1500)
      }
    })
  }, [roomId, transports, mediaControls, assessSession])

  // ---------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------
  const leave = useCallback(() => {
    connectionGenerationRef.current += 1
    joinInFlightRef.current = false
    recoveryInFlightRef.current = false
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
    // `releaseMicTrack` also stops the raw device track hidden behind a gated
    // audio track; for video (and an ungated mic) it is a plain `stop()`.
    localStreamRef.current?.getTracks().forEach((t) => releaseMicTrack(t))
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
    const generation = ++connectionGenerationRef.current

    socket.on("connect_error", (e) => {
      if (!hasJoinedRef.current) {
        dispatch({ type: "ERROR", error: `Не удалось подключиться к серверу: ${e.message}` })
      }
    })

    // Core join sequence — called on first connect and on full rejoin
    const doJoinSequence = async () => {
      if (joinInFlightRef.current || socketRef.current !== socket || connectionGenerationRef.current !== generation) return
      joinInFlightRef.current = true

      // Anything that throws — or never resolves — between here and the end of
      // the ack handler used to leave `status` at "connecting" forever, because
      // the only ways out of the "Подключение к комнате" spinner are CONNECTED
      // and ERROR. Every failure path must therefore clear joinInFlightRef
      // (otherwise later join/rebuild attempts are silently skipped) and report.
      const failJoin = (message: string, cause?: unknown) => {
        joinInFlightRef.current = false
        console.error(`[media] Join failed room=${roomId} peer=${peerIdRef.current}: ${message}`, cause)
        if (socketRef.current !== socket || connectionGenerationRef.current !== generation) return
        // A failure after we're already in the room is handled by the rebuild
        // logic — don't tear down an established session with a fatal error.
        if (!hasJoinedRef.current) dispatch({ type: "ERROR", error: message })
      }

      let device: DeviceType
      try {
        const { Device } = await import("mediasoup-client")
        device = new Device()
        deviceRef.current = device
      } catch (e) {
        // A failed chunk load (flaky network, stale deploy) must not strand the
        // spinner: joinInFlightRef was already set above.
        failJoin("Не удалось загрузить медиа-библиотеку. Обновите страницу.", e)
        return
      }

      type JoinAck = {
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
      }

      const applyJoinAck = async (error: string | null, data: JoinAck | undefined) => {
        try {
          if (socketRef.current !== socket || connectionGenerationRef.current !== generation) {
            joinInFlightRef.current = false
            return
          }
          if (error || !data) {
            joinInFlightRef.current = false
            dispatch({ type: "ERROR", error: error ?? "joinRoom failed" })
            return
          }

          await device.load({ routerRtpCapabilities: data.rtpCapabilities })
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
          if (!newSendTransport) {
            joinInFlightRef.current = false
            return
          }

          // The whole microphone catch-up is wrapped in its own try/catch: a
          // failure here used to bubble into `failJoin`, which does nothing at all
          // once `hasJoinedRef` is true — the session looked connected while the
          // user had no microphone at all. Now it degrades to "mic off" (or to a
          // recovery attempt) and the rest of the join still completes.
          if (hasMicRef.current && !audioProducerRef.current && !audioPublishInFlightRef.current) {
            audioPublishInFlightRef.current = true
            let recoverMicAfterJoin = false
            try {
              let audioTrack = localStreamRef.current?.getAudioTracks()[0]
              // The previous mic track may have ended (device change, OS reclaim,
              // long background) or become structurally silent while we were
              // disconnected. Producing an ended track throws and leaves us mute,
              // so re-acquire whenever the track can't be carrying audio.
              if (diagnoseMicTrack(audioTrack) !== null) {
                try {
                  if (audioTrack) {
                    localStreamRef.current?.removeTrack(audioTrack)
                    releaseMicTrack(audioTrack)
                  }
                  // Re-acquire through the gate, so a rejoin never republishes a
                  // raw (unsuppressed) microphone. `captureMic` falls back to the
                  // system default when the remembered deviceId is gone.
                  const capture = await captureMic(selectedMicIdRef.current)
                  audioTrack = capture.track
                  selectedMicIdRef.current = capture.deviceId ?? undefined
                  localStreamRef.current?.addTrack(audioTrack)
                } catch (micError) {
                  audioTrack = undefined
                  console.error(`[media] Mic re-capture failed room=${roomId} peer=${peerIdRef.current}`, micError)
                }
              }
              if (audioTrack && audioTrack.readyState === "live") {
                audioTrack.enabled = true
                // Re-read the send transport instead of trusting the one captured
                // before the awaits above. Re-acquiring the mic can take well over
                // a second (getUserMedia + the gate's "is it actually flowing"
                // probe), and if the transport closed in that window `produce()`
                // throws — which is exactly how a join ends up with working video
                // and no audio at all.
                const transport = newSendTransport.closed
                  ? await mediaControls.waitForSendTransport()
                  : newSendTransport
                if (!transport || transport.closed) {
                  throw new Error("Send transport unavailable for mic republish")
                }
                const producer = await transport.produce({
                  track: audioTrack,
                  codecOptions: { opusFec: true, opusDtx: true, opusMaxAverageBitrate: 64_000 },
                })
                audioProducerRef.current = producer
                // The join path used to publish without ever watching the track,
                // so a device dying right after entering the room was invisible
                // here — while the identical failure self-healed after a manual
                // toggle. Watch it like every other publish path does.
                mediaControls.watchMicTrack(audioTrack)
                if (isMicMutedRef.current) {
                  audioTrack.enabled = false
                  producer.pause()
                  socket.emit("pauseProducer", {
                    roomId, peerId: peerIdRef.current, producerId: producer.id, paused: true,
                  })
                }
              } else {
                // The microphone is genuinely gone. Mirror what the video branch
                // below does and reflect it in the UI, instead of leaving a "mic
                // on" button over a session nobody can hear.
                dispatch({ type: "TOGGLE_MIC", isMuted: true, hasMic: false })
              }
            } catch (audioError) {
              console.error(`[media] Mic republish failed room=${roomId} peer=${peerIdRef.current}`, audioError)
              // Only flag it here — the call itself has to happen after `finally`
              // releases the publish lock. Clearing the lock inside this catch and
              // invoking recovery immediately was self-defeating in both
              // directions: recoverMic() returns instantly while the lock is held,
              // and once it did start, `finally` would clear the lock out from
              // under the in-flight recovery, letting a concurrent toggle publish a
              // second, orphaned audio producer that no mute ever reaches.
              recoverMicAfterJoin = true
            } finally {
              audioPublishInFlightRef.current = false
              // Lock is released, so recovery can actually run: it retries on the
              // current transport and, if the device is really unavailable, turns
              // the button off instead of leaving silent "mic on" UI.
              if (recoverMicAfterJoin) void mediaControls.recoverMic("join-republish-failed")
            }
          }

          if (hasCamRef.current && !videoProducerRef.current) {
            let videoTrack = localStreamRef.current?.getVideoTracks()[0]
            // Same failure mode as the mic above, but far more common for video:
            // a network drop / device sleep / OS reclaim ends the camera capture
            // track. An ended track can't be produced, so without re-acquiring it
            // we'd publish nothing and every participant (including us) would see
            // a frozen black tile until the user manually toggled the camera.
            if (!videoTrack || videoTrack.readyState === "ended") {
              try {
                if (videoTrack) {
                  videoTrack.stop()
                  localStreamRef.current?.removeTrack(videoTrack)
                }
                const camStream = await navigator.mediaDevices.getUserMedia({ video: true })
                videoTrack = camStream.getVideoTracks()[0]
                if (videoTrack) localStreamRef.current?.addTrack(videoTrack)
              } catch {
                videoTrack = undefined
              }
            }
            if (videoTrack && videoTrack.readyState === "live") {
              const { CAMERA_PRODUCE_OPTIONS } = await import("./mediasoup/types")
              const producer = await newSendTransport.produce({ track: videoTrack, ...CAMERA_PRODUCE_OPTIONS })
              videoProducerRef.current = producer
              if (isCamOffRef.current) {
                videoTrack.enabled = false
                producer.pause()
              }
            } else {
              // The camera is genuinely gone (unplugged, permission revoked).
              // Reflect that in the UI instead of showing a dead "camera on" tile.
              dispatch({ type: "TOGGLE_CAM", isOff: true })
            }
          }

          // A full rejoin replaces the send transport and invalidates all old
          // producers. Re-publish the still-live capture tracks without opening
          // the browser/Electron source picker again.
          if (screenStreamRef.current?.getVideoTracks()[0]?.readyState === "live") {
            await mediaControls.recoverScreenShare()
          }
          joinInFlightRef.current = false
        } catch (e) {
          // device.load / setupTransports / produce can all throw (unsupported
          // browser, revoked permission, transport closed mid-setup). Rejections
          // inside a socket.io ack callback are swallowed, so previously
          // CONNECTED was simply never dispatched and the spinner spun forever.
          failJoin("Не удалось войти в комнату. Попробуйте переподключиться.", e)
        }
      }

      // socket.io does not time out acknowledgements: if the server never calls
      // back (hung DB query, dead mediasoup worker, lost WebSocket upgrade) the
      // client waited indefinitely. Bound that wait explicitly.
      let ackSettled = false
      const ackTimeout = setTimeout(() => {
        if (ackSettled) return
        ackSettled = true
        failJoin("Сервер не ответил на запрос входа в комнату. Проверьте соединение и попробуйте снова.")
      }, JOIN_ACK_TIMEOUT_MS)

      socket.emit(
        "joinRoom",
        { roomId, peerId: peerIdRef.current, clientId: CLIENT_ID, displayName, rtpCapabilities: {}, create },
        (error: string | null, data: JoinAck | undefined) => {
          if (ackSettled) return
          ackSettled = true
          clearTimeout(ackTimeout)
          void applyJoinAck(error, data)
        },
      )
    }

    const closeCurrentMediaSession = () => {
      const producers = [audioProducerRef.current, videoProducerRef.current, screenVideoProducerRef.current, screenAudioProducerRef.current]
      audioProducerRef.current = null
      videoProducerRef.current = null
      screenVideoProducerRef.current = null
      screenAudioProducerRef.current = null
      producers.forEach((producer) => producer?.close())
      sendTransportRef.current?.close()
      recvTransportRef.current?.close()
      sendTransportRef.current = null
      recvTransportRef.current = null
      consumersRef.current.forEach((consumer) => consumer.close())
      consumersRef.current.clear()
      pendingClosedProducersRef.current.clear()
      iceRestartingRef.current.clear()
      iceRetryTimersRef.current.forEach((timer) => clearTimeout(timer))
      iceRetryTimersRef.current.clear()
    }

    const rebuildMediaSession = async (reason: string) => {
      if (recoveryInFlightRef.current || socketRef.current !== socket || !socket.connected) return
      // A rebuild closes every producer/transport and re-joins, which the other
      // participants see as this person dropping out and coming back. When the
      // network is genuinely bad the ICE watchdogs used to trigger it every few
      // seconds, producing an endless leave/join flicker for everyone. Enforce a
      // cooldown so at most one rebuild happens per window and the transports
      // get a real chance to settle in between.
      // A rejected rejoin probe means the server no longer knows this peer, so a
      // rebuild is the only way back in and must not be throttled.
      const force = reason.startsWith("rejoin-") || reason.startsWith("manual-probe-")
      const now = Date.now()
      if (!force && now - lastRebuildAtRef.current < REBUILD_COOLDOWN_MS) {
        console.warn(`[media] Rebuild throttled room=${roomId} peer=${peerIdRef.current} reason=${reason}`)
        return
      }
      lastRebuildAtRef.current = now
      recoveryInFlightRef.current = true
      console.warn(`[media] Rebuild started room=${roomId} peer=${peerIdRef.current} socket=${socket.id} reason=${reason}`)
      try {
        closeCurrentMediaSession()
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error("resetMediaState acknowledgement timeout"))
          }, 8000)
          socket.emit("resetMediaState", { roomId, peerId: peerIdRef.current }, (error: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (error) reject(new Error(error))
            else resolve()
          })
        }).catch((error) => {
          // The peer may already have been evicted during a long outage. In that
          // case reset is unnecessary and joinRoom below recreates it.
          console.warn(`[media] Server reset skipped room=${roomId} peer=${peerIdRef.current}`, error)
          hasJoinedRef.current = false
        })
        joinInFlightRef.current = false
        await doJoinSequence()
        if (screenStreamRef.current?.getVideoTracks()[0]?.readyState === "live") {
          await mediaControls.recoverScreenShare()
        }
        console.info(`[media] Rebuild completed room=${roomId} peer=${peerIdRef.current} socket=${socket.id}`)
      } catch (error) {
        joinInFlightRef.current = false
        console.error(`[media] Rebuild failed room=${roomId} peer=${peerIdRef.current} socket=${socket.id}`, error)
        dispatch({ type: "ERROR", error: "Не удалось восстановить аудио/видео. Переподключитесь к комнате." })
      } finally {
        recoveryInFlightRef.current = false
      }
    }
    rebuildConnectionRef.current = rebuildMediaSession

    // ---------------------------------------------------------------------------
    // Socket event listeners
    // ---------------------------------------------------------------------------
    socket.on("connect", async () => {
      console.info(`[socket] Connected room=${roomId} peer=${peerIdRef.current} socket=${socket.id} recovered=${hasJoinedRef.current}`)
      if (!hasJoinedRef.current) {
        await doJoinSequence()
        return
      }
      if (recoveryInFlightRef.current) return
      recoveryInFlightRef.current = true
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        recoveryInFlightRef.current = false
        void rebuildMediaSession("rejoin-probe-timeout")
      }, 8000)
      socket.emit("rejoinProbe", { roomId, peerId: peerIdRef.current, clientId: CLIENT_ID }, (error: string | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        recoveryInFlightRef.current = false
        if (socketRef.current !== socket || connectionGenerationRef.current !== generation) return
        console.info(`[socket] Rejoin probe room=${roomId} peer=${peerIdRef.current} socket=${socket.id} result=${error ?? "accepted"}`)
        if (!error) {
          // A socket reconnect does not necessarily mean the media path broke
          // (a short WebSocket blip leaves ICE and the capture tracks intact).
          // Only repair what is actually damaged — a blanket ICE restart here
          // freezes a perfectly healthy camera / screen share.
          const assessment = assessSession()
          if (assessment.sendBroken) transports.restartIceForTransport(sendTransportRef.current)
          if (assessment.recvBroken) transports.restartIceForTransport(recvTransportRef.current)
          // The microphone is just as fragile as the camera during an outage —
          // and a dead mic is worse, because nothing about the UI reveals it.
          if (assessment.micBroken) void mediaControls.recoverMic("rejoin-probe")
          // The camera capture track often dies during the outage even though
          // the transport itself is reusable. Re-check and republish it.
          if (assessment.camBroken) void mediaControls.recoverCamera()
          if (assessment.screenBroken) {
            window.setTimeout(() => { void mediaControls.recoverScreenShare() }, 1500)
          }
        } else {
          hasJoinedRef.current = false
          void rebuildMediaSession(`rejoin-rejected:${error}`)
        }
      })
    })

    socket.on("disconnect", (reason) => {
      console.warn(`[socket] Disconnected room=${roomId} peer=${peerIdRef.current} socket=${socket.id ?? "none"} reason=${reason}`)
    })

    registerRoomSocketListeners(socket, {
      dispatch,
      peerIdRef,
      consumersRef,
      pendingClosedProducersRef,
      kickedRef,
      hasJoinedRef,
      sendTransportRef,
      recvTransportRef,
      consumeProducer: transports.consumeProducer,
      whiteboardListenersRef: whiteboard.whiteboardListenersRef,
      annotationStrokeListenersRef: whiteboard.annotationStrokeListenersRef,
      annotationClearListenersRef: whiteboard.annotationClearListenersRef,
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

  // Recover media after a network return, tab restore, or mobile foreground.
  useEffect(() => {
    const onOnline = () => recoverConnection()
    const onVisible = () => {
      if (document.visibilityState === "visible") recoverConnection()
    }
    const onPageShow = () => recoverConnection()
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [recoverConnection])

  // ---------------------------------------------------------------------------
  // Fast leave on real tab/browser close
  //
  // A socket "disconnect" alone can't tell "user closed the tab" from "phone
  // locked / network hiccup", so the server keeps a long grace window and other
  // participants would see the person hang around for ~a minute. When the page
  // is genuinely being unloaded the browser fires pagehide/beforeunload, so we
  // send a reliable navigator.sendBeacon telling the server we're leaving — it
  // then evicts us on a short window (~6s) instead of the full grace.
  //
  // We deliberately skip bfcache freezes (pagehide with event.persisted), which
  // is what fires on mobile backgrounding / screen-lock — those must keep the
  // long grace so a quick return doesn't kick the user out.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sendLeaveBeacon = () => {
      if (!hasJoinedRef.current) return
      if (typeof navigator === "undefined" || !navigator.sendBeacon) return
      const url = `${SERVER_URL}/rooms/${encodeURIComponent(roomId)}/leave?peerId=${encodeURIComponent(peerIdRef.current)}`
      try { navigator.sendBeacon(url) } catch { /* best-effort */ }
    }
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return
      sendLeaveBeacon()
    }
    const onBeforeUnload = () => { sendLeaveBeacon() }
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("beforeunload", onBeforeUnload)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------
  return {
    // Status
    status: state.status,
    error: state.error,
    permissionError: mediaControls.permissionError,
    clearPermissionError: mediaControls.clearPermissionError,
    // Non-fatal microphone problems (publish failed, device vanished, recovery
    // gave up). Shown as a dismissible banner — never as a fatal room error.
    micNotice: mediaControls.micNotice,
    clearMicNotice: mediaControls.clearMicNotice,
    localPeerId: peerIdRef.current,
    // Peers & streams
    peers: state.peers,
    localStream: state.localStream,
    localScreenStream: screenStreamRef.current,
    // Media state
    isMicMuted: state.isMicMuted,
    isCamOff: state.isCamOff,
    isCamStarting: mediaControls.isCamStarting,
    activeMicId: mediaControls.activeMicId,
    isMicSwitching: mediaControls.isMicSwitching,
    isScreenSharing: state.isScreenSharing,
    hasMic: state.hasMic,
    hasCam: state.hasCam,
    // Media controls
    toggleMic: mediaControls.toggleMic,
    toggleCam: mediaControls.toggleCam,
    toggleScreenShare: mediaControls.toggleScreenShare,
    stopScreenShare: mediaControls.stopScreenShare,
    switchMic: mediaControls.switchMic,
    screenQuality: mediaControls.screenQuality,
    setScreenQuality: mediaControls.setScreenQuality,
    // Connection
    leave,
    recoverConnection,
    // Weak-network guard
    networkQuality: networkGuard.networkQuality,
    uplinkQuality: networkGuard.uplinkQuality,
    downlinkQuality: networkGuard.downlinkQuality,
    videoMode: networkGuard.videoMode,
    setVideoMode: networkGuard.setVideoMode,
    videoDegraded: networkGuard.videoDegraded,
    uplinkVideoSuppressed: networkGuard.uplinkVideoSuppressed,
    downlinkVideoSuppressed: networkGuard.downlinkVideoSuppressed,
    // Lets the camera button override a guard-imposed blackout. The UI needs it
    // directly: pressing the button while the guard holds the camera down must
    // restore video, not toggle `isCamOff` and strand the user off-camera.
    noteUserWantsVideo: networkGuard.noteUserWantsVideo,
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
