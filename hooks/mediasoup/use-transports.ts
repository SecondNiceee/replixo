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

          socket.emit("resumeConsumer", {
            roomId,
            peerId: peerIdRef.current,
            consumerId: data.consumerId,
          })
        },
      )
    },
    [roomId, peerIdRef, socketRef, deviceRef, recvTransportRef, consumersRef,
     pendingClosedProducersRef, dispatch],
  )

  return { createTransport, setupTransports, consumeProducer, restartIceForTransport, clearIceRetry }
}
