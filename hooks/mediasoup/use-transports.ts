"use client"

import { useCallback, useRef } from "react"
import type { Socket } from "socket.io-client"
import type { DeviceType, Transport, Consumer, Producer, MediaSource } from "./types"
import { normalizeSource } from "./types"
import type { Action } from "./reducer"

interface UseTransportsParams {
  roomId: string
  peerIdRef: React.MutableRefObject<string>
  socketRef: React.MutableRefObject<Socket | null>
  deviceRef: React.MutableRefObject<DeviceType | null>
  sendTransportRef: React.MutableRefObject<Transport | null>
  recvTransportRef: React.MutableRefObject<Transport | null>
  consumersRef: React.MutableRefObject<Map<string, Consumer>>
  pendingClosedProducersRef: React.MutableRefObject<Set<string>>
  iceRestartingRef: React.MutableRefObject<Set<string>>
  iceRetryTimersRef: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>
  audioProducerRef: React.MutableRefObject<Producer | null>
  videoProducerRef: React.MutableRefObject<Producer | null>
  screenVideoProducerRef: React.MutableRefObject<Producer | null>
  screenAudioProducerRef: React.MutableRefObject<Producer | null>
  dispatch: (action: Action) => void
}

export function useTransports({
  roomId,
  peerIdRef,
  socketRef,
  deviceRef,
  sendTransportRef,
  recvTransportRef,
  consumersRef,
  pendingClosedProducersRef,
  iceRestartingRef,
  iceRetryTimersRef,
  audioProducerRef,
  videoProducerRef,
  screenVideoProducerRef,
  screenAudioProducerRef,
  dispatch,
}: UseTransportsParams) {
  // ---------------------------------------------------------------------------
  // ICE restart helpers
  // ---------------------------------------------------------------------------
  const clearIceRetry = useCallback((transportId: string) => {
    const t = iceRetryTimersRef.current.get(transportId)
    if (t) {
      clearTimeout(t)
      iceRetryTimersRef.current.delete(transportId)
    }
  }, [iceRetryTimersRef])

  // Resolves once the transport's ICE/DTLS is actually connected (or it closes,
  // or we hit the timeout as a safety fallback). Used to avoid resuming a video
  // consumer before its recv transport is ready — see consumeProducer below.
  const waitForTransportConnected = useCallback(
    (transport: Transport, timeoutMs = 8000): Promise<void> =>
      new Promise((resolve) => {
        if (transport.closed || transport.connectionState === "connected") { resolve(); return }
        const started = Date.now()
        const id = setInterval(() => {
          if (
            transport.closed ||
            transport.connectionState === "connected" ||
            Date.now() - started >= timeoutMs
          ) {
            clearInterval(id)
            resolve()
          }
        }, 100)
      }),
    [],
  )

  const restartIceForTransport = useCallback(
    (transport: Transport | null, attempt = 0) => {
      const socket = socketRef.current
      if (!socket || !transport || transport.closed) return
      if (attempt === 0 && iceRestartingRef.current.has(transport.id)) return
      iceRestartingRef.current.add(transport.id)

      const scheduleRetry = () => {
        if (transport.closed || transport.connectionState === "connected") {
          clearIceRetry(transport.id)
          return
        }
        const delay = Math.min(1000 * 2 ** attempt, 8000)
        clearIceRetry(transport.id)
        const timer = setTimeout(() => restartIceForTransport(transport, attempt + 1), delay)
        iceRetryTimersRef.current.set(transport.id, timer)
      }

      socket.emit(
        "restartIce",
        { roomId, peerId: peerIdRef.current, transportId: transport.id },
        async (error: string | null, iceParameters: object | undefined) => {
          iceRestartingRef.current.delete(transport.id)
          if (error || !iceParameters) {
            scheduleRetry()
            return
          }
          try {
            await transport.restartIce({ iceParameters })
            // Re-sync paused state of all producers after ICE recovery
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
                    peerId: peerIdRef.current,
                    producerId: producer.id,
                    paused: producer.paused,
                  })
                }
              }
            }
            scheduleRetry()
          } catch {
            scheduleRetry()
          }
        },
      )
    },
    [roomId, peerIdRef, socketRef, sendTransportRef, audioProducerRef, videoProducerRef,
     screenVideoProducerRef, screenAudioProducerRef, iceRestartingRef, iceRetryTimersRef, clearIceRetry],
  )

  // ---------------------------------------------------------------------------
  // Create a single WebRTC transport (send or recv)
  // ---------------------------------------------------------------------------
  const createTransport = useCallback(
    (socket: Socket, device: DeviceType, direction: "send" | "recv"): Promise<Transport> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createWebRtcTransport",
          { roomId, peerId: peerIdRef.current, direction },
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

            // Device/Transport типизированы как any (см. types.ts) — mediasoup-client
            // сам валидирует параметры, дополнительные касты не нужны.
            const opts = {
              id: transportData.transportId,
              iceParameters: transportData.iceParameters,
              iceCandidates: transportData.iceCandidates as RTCIceCandidate[],
              dtlsParameters: transportData.dtlsParameters,
              iceServers: transportData.iceServers as RTCIceServer[],
            }

            const transport = direction === "send"
              ? device.createSendTransport(opts)
              : device.createRecvTransport(opts)

            transport.on("connect", ({ dtlsParameters }: { dtlsParameters: object }, callback: () => void, errback: (e: Error) => void) => {
              socket.emit(
                "connectTransport",
                { roomId, peerId: peerIdRef.current, transportId: transport.id, dtlsParameters },
                (err: string | null) => { err ? errback(new Error(err)) : callback() },
              )
            })

            transport.on("connectionstatechange", (connectionState: string) => {
              if (connectionState === "disconnected" || connectionState === "failed") {
                restartIceForTransport(transport)
              } else if (connectionState === "connected") {
                clearIceRetry(transport.id)
              }
            })

            if (direction === "send") {
              transport.on(
                "produce",
                (
                  { kind, rtpParameters, appData }: { kind: string; rtpParameters: object; appData: object },
                  callback: (r: { id: string }) => void,
                  errback: (e: Error) => void,
                ) => {
                  socket.emit(
                    "produce",
                    { roomId, peerId: peerIdRef.current, transportId: transport.id, kind, rtpParameters, appData },
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
    [roomId, peerIdRef, restartIceForTransport, clearIceRetry],
  )

  // ---------------------------------------------------------------------------
  // Setup both transports and consume existing peers' producers
  // ---------------------------------------------------------------------------
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
      const [send, recv] = await Promise.all([
        createTransport(socket, device, "send"),
        createTransport(socket, device, "recv"),
      ])
      sendTransportRef.current = send
      recvTransportRef.current = recv

      // Register every existing peer FIRST, before consuming their producers.
      // A peer sitting with mic muted and camera off has no producers, so if we
      // only created peer entries while consuming media (as below) such peers
      // would be invisible to a newcomer — they'd see fewer participants than
      // everyone else. Dispatching PEER_JOINED here guarantees the roster is
      // complete regardless of who is currently sending audio/video.
      for (const { peerId: remotePeerId, displayName } of existingPeers) {
        dispatch({ type: "PEER_JOINED", peerId: remotePeerId, displayName })
      }

      await Promise.all(
        existingPeers.flatMap(({ peerId: remotePeerId, displayName, producers }) =>
          producers.map(({ producerId, kind, appData }) =>
            consumeProducer(remotePeerId, displayName, producerId, kind as "audio" | "video", appData),
          ),
        ),
      )
    },
    [createTransport, sendTransportRef, recvTransportRef], // consumeProducer added below
  )

  // ---------------------------------------------------------------------------
  // Lifecycle watchdog for video consumers.
  //
  // A video decoder can remain on its last frame after a short network outage
  // even though the shared recv transport (and therefore audio) has recovered.
  // Keep watching RTP progress for the whole consumer lifetime. During startup
  // request keyframes quickly until the first frame arrives. Afterwards only
  // request one when RTP bytes continue arriving but decoded frames repeatedly
  // do not advance; this avoids false positives for a genuinely static screen.
  // ---------------------------------------------------------------------------
  const videoWatchdogTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const startVideoFrameWatchdog = useCallback(
    (consumer: Consumer, consumerId: string) => {
      const existingTimer = videoWatchdogTimersRef.current.get(consumerId)
      if (existingTimer) clearTimeout(existingTimer)

      let hasDecodedFrame = false
      let startupAttempts = 0
      let stalledChecks = 0
      let lastFramesDecoded = 0
      let lastBytesReceived = 0
      let lastKeyFrameRequestAt = 0

      const schedule = (delay: number) => {
        const timer = setTimeout(tick, delay)
        videoWatchdogTimersRef.current.set(consumerId, timer)
      }

      const requestKeyFrame = () => {
        const socket = socketRef.current
        if (!socket) return
        lastKeyFrameRequestAt = Date.now()
        socket.emit("requestConsumerKeyFrame", {
          roomId,
          peerId: peerIdRef.current,
          consumerId,
        })
      }

      const tick = async () => {
        if (consumer.closed) {
          videoWatchdogTimersRef.current.delete(consumerId)
          return
        }

        let framesDecoded = lastFramesDecoded
        let bytesReceived = lastBytesReceived
        let hasInboundStats = false

        try {
          const stats: RTCStatsReport = await consumer.getStats()
          stats.forEach((report: Record<string, unknown>) => {
            if (report.type !== "inbound-rtp") return
            hasInboundStats = true
            if (typeof report.framesDecoded === "number") {
              framesDecoded = Math.max(framesDecoded, report.framesDecoded)
            }
            if (typeof report.bytesReceived === "number") {
              bytesReceived = Math.max(bytesReceived, report.bytesReceived)
            }
          })
        } catch {
          // Stats can be temporarily unavailable while ICE is recovering.
        }

        const framesAdvanced = framesDecoded > lastFramesDecoded
        const bytesAdvanced = bytesReceived > lastBytesReceived

        if (framesDecoded > 0) hasDecodedFrame = true

        if (!hasDecodedFrame) {
          startupAttempts += 1
          if (startupAttempts <= 15) requestKeyFrame()
        } else if (hasInboundStats && framesAdvanced) {
          stalledChecks = 0
        } else if (hasInboundStats && bytesAdvanced) {
          stalledChecks += 1
          if (stalledChecks >= 2 && Date.now() - lastKeyFrameRequestAt >= 4000) {
            requestKeyFrame()
            stalledChecks = 0
          }
        } else {
          // No RTP arrived. Wait for the path to recover; once inter-frames start
          // arriving again, bytes will advance and the branch above requests an
          // immediately useful keyframe.
          stalledChecks = 0
        }

        lastFramesDecoded = framesDecoded
        lastBytesReceived = bytesReceived
        schedule(hasDecodedFrame ? 2000 : 800)
      }

      // Give transport connect + resume a brief head start.
      schedule(600)
    },
    [roomId, peerIdRef, socketRef],
  )

  // ---------------------------------------------------------------------------
  // Consume a remote producer
  // ---------------------------------------------------------------------------
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
          peerId: peerIdRef.current,
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
          if (error || !data) return

          const rawSource = appData?.source ?? (data.appData as Record<string, unknown>)?.source
          const source: MediaSource = rawSource === "screen" ? "screen" : "media"

          const consumer = await recvTransport.consume({
            id: data.consumerId,
            producerId: data.producerId,
            kind: data.kind as "audio" | "video",
            rtpParameters: data.rtpParameters as RTCRtpParameters,
            appData: { source },
          })

          // Race guard: producer closed before consumer was ready
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

          consumersRef.current.set(data.consumerId, consumer)

          const stream = new MediaStream([consumer.track])
          dispatch({ type: "PEER_STREAM", peerId: remotePeerId, displayName, kind, source, stream })

          // Surface initial mute state
          if (kind === "audio" && source === "media" && data.producerPaused) {
            dispatch({ type: "PEER_AUDIO_MUTED", peerId: remotePeerId, muted: true })
          }

          // Wait until the recv transport is actually connected before resuming.
          // The transport starts its DTLS/ICE handshake when the first consumer
          // is created (the `consume` above), so on the very first stream in a
          // room `connectionState` is still "connecting" here. mediasoup asks the
          // producer for a keyframe the moment a consumer resumes — if we resume
          // before the transport is connected that keyframe is dropped and the
          // decoder is left waiting, which shows up as a permanent black frame
          // until the next keyframe (e.g. after the sender toggles the camera).
          // Gating resume on "connected" guarantees the keyframe lands on a live
          // path. Subsequent consumers reuse the already-connected transport and
          // resolve immediately.
          await waitForTransportConnected(recvTransport)

          socket.emit("resumeConsumer", {
            roomId,
            peerId: peerIdRef.current,
            consumerId: data.consumerId,
          })

          // Guard against a persistent black frame (see watchdog above): keep
          // nudging the server for a keyframe until frames actually decode.
          if (kind === "video") {
            startVideoFrameWatchdog(consumer, data.consumerId)
          }
        },
      )
    },
    [roomId, peerIdRef, socketRef, deviceRef, recvTransportRef, consumersRef,
     pendingClosedProducersRef, dispatch, waitForTransportConnected, startVideoFrameWatchdog],
  )

  return { createTransport, setupTransports, consumeProducer, restartIceForTransport, clearIceRetry }
}
