import type { Worker } from 'mediasoup/node/lib/types'
import { Peer } from '../Peer'
import { getRoomMessages, getRoomReadMarkers } from '../db'
import type {
  JoinRoomPayload,
  CreateTransportPayload,
  ConnectTransportPayload,
  ProducePayload,
  ConsumePayload,
  ResumeConsumerPayload,
  CloseProducerPayload,
  PauseProducerPayload,
} from '../types'
import { ack, err, type Callback, type HandlerContext } from './helpers'
import {
  rooms,
  peerSockets,
  clearPendingDisconnect,
  getOrCreateRoom,
  cleanupRoomIfEmpty,
} from './room-registry'

// ---------------------------------------------------------------------------
// WebRTC / mediasoup signalling: joinRoom, transports, produce/consume
// ---------------------------------------------------------------------------

export function registerMediaHandlers(ctx: HandlerContext, worker: Worker): void {
  const { io, socket, session } = ctx

  // -----------------------------------------------------------------------
  // joinRoom
  // -----------------------------------------------------------------------
  socket.on(
    'joinRoom',
    async (payload: JoinRoomPayload, callback: Callback<{ rtpCapabilities: object; existingPeers: object[] }>) => {
      const { roomId, peerId, displayName, rtpCapabilities, create } = payload

      try {
        if (!create && !rooms.has(roomId)) {
          return err(callback as Callback<never>, 'Комната не найдена')
        }

        // If this peerId is already connected from another socket (another tab /
        // device), kick the old session so only the latest one stays.
        const existingSocketId = peerSockets.get(peerId)
        if (existingSocketId && existingSocketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existingSocketId)
          if (oldSocket) {
            oldSocket.emit('kicked', { reason: 'duplicate' })
            oldSocket.disconnect(true)
          }
          // Remove the old peer from whatever room it was in
          for (const [rid, r] of rooms.entries()) {
            if (r.hasPeer(peerId)) {
              r.removePeer(peerId)
              io.to(rid).emit('peerLeft', { peerId })
              cleanupRoomIfEmpty(rid)
              break
            }
          }
        }

        // This peer is (re)joining — cancel any pending grace-window eviction.
        clearPendingDisconnect(peerId)

        const room = await getOrCreateRoom(roomId, worker)

        if (room.isFull()) return err(callback as Callback<never>, 'Room is full (max 5 participants)')
        // After kicking the old socket above, the peer should no longer be in the
        // room. But guard defensively just in case.
        if (room.hasPeer(peerId)) {
          room.removePeer(peerId)
        }

        const peer = new Peer({ peerId, displayName, socketId: socket.id })
        peer.rtpCapabilities = rtpCapabilities
        room.addPeer(peer)

        session.roomId = roomId
        session.peerId = peerId
        peerSockets.set(peerId, socket.id)
        socket.join(roomId)

        const existingPeers = room.getExistingPeersFor(peerId)
        console.log(`[room] Peer ${peerId} (${displayName}) joined room ${roomId} — peers: ${room.getPeerIds().length}`)

        // Notify other peers that someone joined, even before they produce media
        socket.to(roomId).emit('peerJoined', { peerId, displayName })

        // Load persisted chat history so the joining peer (or someone who just
        // reloaded the page) sees prior messages. Empty when persistence is off.
        const messages = await getRoomMessages(roomId)
        // Read markers of every participant so checkmarks render correctly on
        // already-sent messages right after joining/reloading.
        const readMarkers = await getRoomReadMarkers(roomId)

        // Serialize presentationDrawings Map → plain object for JSON transport.
        const presentationDrawings: Record<string, string> = {}
        for (const [idx, snap] of room.presentationDrawings.entries()) {
          presentationDrawings[String(idx)] = snap
        }

        ack(callback, {
          rtpCapabilities: room.getRtpCapabilities(),
          existingPeers,
          currentSlide: room.currentSlide ?? null,
          messages,
          readMarkers,
          // Shared whiteboard: whether it's open for everyone and the latest
          // full snapshot so a mid-session joiner sees the current drawing.
          whiteboardOpen: room.whiteboardOpen,
          whiteboardSnapshot: room.whiteboardSnapshot,
          // Presentation drawing annotations — one snapshot per slide index.
          presentationDrawings,
        })
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // createWebRtcTransport
  // -----------------------------------------------------------------------
  socket.on(
    'createWebRtcTransport',
    async (payload: CreateTransportPayload, callback: Callback<object>) => {
      const { roomId, peerId, direction } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const transportData = await room.createWebRtcTransport(peerId, direction ?? 'send')
        ack(callback, transportData)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // connectTransport
  // -----------------------------------------------------------------------
  socket.on(
    'connectTransport',
    async (payload: ConnectTransportPayload, callback: Callback<void>) => {
      const { roomId, peerId, transportId, dtlsParameters } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        await room.connectTransport(peerId, transportId, dtlsParameters)
        ack(callback, undefined)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // restartIce  (called by client when transport ICE state => disconnected/failed)
  // -----------------------------------------------------------------------
  socket.on(
    'restartIce',
    async (
      payload: { roomId: string; peerId: string; transportId: string },
      callback: Callback<object>,
    ) => {
      const { roomId, peerId, transportId } = payload
      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const iceParameters = await room.restartIce(peerId, transportId)
        ack(callback, iceParameters)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // produce
  // -----------------------------------------------------------------------
  socket.on(
    'produce',
    async (payload: ProducePayload, callback: Callback<{ producerId: string }>) => {
      const { roomId, peerId, transportId, kind, rtpParameters, appData = {} } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const peer = room.getPeer(peerId)
        if (!peer) return err(callback as Callback<never>, `Peer ${peerId} not found`)

        const result = await room.produce(peerId, transportId, kind, rtpParameters, appData)

        // Notify all other peers in the room about the new producer
        socket.to(roomId).emit('newProducer', {
          peerId,
          displayName: peer.displayName,
          producerId: result.producerId,
          kind,
          appData,
        })

        ack(callback, { producerId: result.producerId })
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // consume
  // -----------------------------------------------------------------------
  socket.on(
    'consume',
    async (payload: ConsumePayload, callback: Callback<object>) => {
      const { roomId, peerId, producerId, rtpCapabilities } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        const consumerData = await room.consume(peerId, producerId, rtpCapabilities)
        ack(callback, consumerData)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // resumeConsumer
  // -----------------------------------------------------------------------
  socket.on(
    'resumeConsumer',
    async (payload: ResumeConsumerPayload, callback: Callback<void>) => {
      const { roomId, peerId, consumerId } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) return err(callback as Callback<never>, `Room ${roomId} not found`)

        await room.resumeConsumer(peerId, consumerId)
        ack(callback, undefined)
      } catch (e) {
        err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // requestConsumerKeyFrame  (client-driven black-frame recovery)
  //
  // Emitted by a viewer whose video consumer has resumed but is still showing
  // a black frame (no decoded frames yet). We push a fresh keyframe on demand;
  // the client keeps asking until its decoder actually produces a picture.
  // -----------------------------------------------------------------------
  socket.on(
    'requestConsumerKeyFrame',
    async (payload: ResumeConsumerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        await room.requestConsumerKeyFrame(peerId, consumerId)
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // closeProducer  (e.g. stop screen sharing)
  // -----------------------------------------------------------------------
  socket.on(
    'closeProducer',
    (payload: CloseProducerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, producerId } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        room.closeProducer(peerId, producerId)
        socket.to(roomId).emit('producerClosed', { peerId, producerId })
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )

  // -----------------------------------------------------------------------
  // pauseProducer / resumeProducer  (e.g. mute / unmute microphone)
  // -----------------------------------------------------------------------
  socket.on(
    'pauseProducer',
    async (payload: PauseProducerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, producerId, paused } = payload

      try {
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        if (paused) {
          await room.pauseProducer(peerId, producerId)
        } else {
          await room.resumeProducer(peerId, producerId)
        }

        // Inform other peers so they can update UI (e.g. mute indicator)
        socket.to(roomId).emit('producerPaused', { peerId, producerId, paused })
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
      }
    },
  )
}
