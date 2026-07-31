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
  PauseConsumerPayload,
  CloseProducerPayload,
  PauseProducerPayload,
} from '../types'
import { ack, err, type Callback, type HandlerContext } from './helpers'
import { canonicalRoomCode } from '../room-code'
import {
  rooms,
  clearPendingDisconnect,
  getPeerSocket,
  setPeerSocket,
  getPeerClient,
  setPeerClient,
  getOrCreateRoom,
  evictPeer,
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
      const { peerId, displayName, rtpCapabilities, create, clientId } = payload ?? {}
      const roomId = canonicalRoomCode(payload?.roomId)

      try {
        if (!roomId || typeof peerId !== 'string' || !peerId || typeof displayName !== 'string' || !displayName.trim()) {
          return err(callback as Callback<never>, 'Некорректные данные подключения')
        }
        if (!create && !rooms.has(roomId)) {
          return err(callback as Callback<never>, 'Комната не найдена')
        }

        if (session.roomId && session.peerId && (session.roomId !== roomId || session.peerId !== peerId)) {
          evictPeer(io, session.roomId, session.peerId, socket.id)
          socket.leave(session.roomId)
          session.roomId = null
          session.peerId = null
        }

        const existingSocketId = getPeerSocket(roomId, peerId)
        if (existingSocketId && existingSocketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existingSocketId)
          // The same page instance reconnecting (network hand-off, sleep/wake)
          // sends the same clientId. That must never be treated as a clone,
          // otherwise the client kicks itself out of the room it is recovering
          // into — and `kicked` is terminal on the client.
          const sameClient = !!clientId && getPeerClient(roomId, peerId) === clientId
          if (oldSocket?.connected && !sameClient) {
            // Genuine duplicate: the same browser profile opened this room a
            // second time (extra tab/window). peerId is derived from a
            // persistent device id, so the stale session is kicked here instead
            // of becoming a second participant that takes a slot and fights
            // over producers.
            console.warn(`[room] Duplicate session kicked room=${roomId} peer=${peerId} oldSocket=${existingSocketId} newSocket=${socket.id}`)
            oldSocket.emit('kicked', { reason: 'duplicate' })
            oldSocket.disconnect(true)
          } else if (oldSocket?.connected) {
            // Same page, new socket: drop the stale transport silently, no kick.
            console.info(`[room] Reconnect takeover room=${roomId} peer=${peerId} oldSocket=${existingSocketId} newSocket=${socket.id}`)
            oldSocket.disconnect(true)
          }
          evictPeer(io, roomId, peerId, existingSocketId)
        }

        clearPendingDisconnect(roomId, peerId)

        const room = await getOrCreateRoom(roomId, worker)
        const repeatedJoin = room.hasPeer(peerId) && getPeerSocket(roomId, peerId) === socket.id

        if (!repeatedJoin && room.isFull()) return err(callback as Callback<never>, 'Room is full (max 5 participants)')

        if (repeatedJoin) {
          const peer = room.getPeer(peerId)!
          peer.displayName = displayName.trim()
          peer.rtpCapabilities = rtpCapabilities
        } else {
          const peer = new Peer({ peerId, displayName: displayName.trim(), socketId: socket.id })
          peer.rtpCapabilities = rtpCapabilities
          room.addPeer(peer)
        }

        session.roomId = roomId
        session.peerId = peerId
        setPeerSocket(roomId, peerId, socket.id)
        setPeerClient(roomId, peerId, typeof clientId === 'string' ? clientId : undefined)
        socket.join(roomId)

        const existingPeers = room.getExistingPeersFor(peerId)
        console.log(`[room] ${repeatedJoin ? 'Repeated join ignored for' : 'Peer joined'} room=${roomId} peer=${peerId} socket=${socket.id} peers=${room.getPeerIds().length}`)

        // A repeated acknowledgement from the same socket must not create a
        // second presence event or replay the join sound for other clients.
        if (!repeatedJoin) socket.to(roomId).emit('peerJoined', { peerId, displayName: displayName.trim() })

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
  // resetMediaState — rebuild transports without removing room presence
  // -----------------------------------------------------------------------
  socket.on(
    'resetMediaState',
    (payload: { roomId: string; peerId: string }, callback: Callback<void>) => {
      const roomId = canonicalRoomCode(payload?.roomId)
      const peerId = payload?.peerId
      try {
        if (!roomId || typeof peerId !== 'string') return err(callback as Callback<never>, 'Invalid media reset payload')
        if (session.roomId !== roomId || session.peerId !== peerId || getPeerSocket(roomId, peerId) !== socket.id) {
          console.warn(`[media] Reset rejected room=${roomId} peer=${peerId} socket=${socket.id}`)
          return err(callback as Callback<never>, 'Socket does not own this peer')
        }
        const room = rooms.get(roomId)
        const peer = room?.getPeer(peerId)
        if (!room || !peer) return err(callback as Callback<never>, 'Peer not found')

        const producerIds = [...peer.producers.keys()]
        const transportCount = peer.transports.size
        const consumerCount = peer.consumers.size
        peer.resetMedia()
        for (const producerId of producerIds) {
          socket.to(roomId).emit('producerClosed', { peerId, producerId })
        }
        console.log(`[media] State reset room=${roomId} peer=${peerId} socket=${socket.id} transports=${transportCount} producers=${producerIds.length} consumers=${consumerCount}`)
        ack(callback, undefined)
      } catch (e) {
        console.error(`[media] State reset failed room=${roomId} peer=${peerId} socket=${socket.id}`, e)
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

        console.log(`[media] ICE restart room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`)
        const iceParameters = await room.restartIce(peerId, transportId)
        ack(callback, iceParameters)
      } catch (e) {
        console.error(`[media] ICE restart failed room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`, e)
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
  // pauseConsumer  (client-driven weak-downlink protection)
  //
  // The viewer's network guard decided that incoming video is drowning its
  // audio and asked us to stop forwarding it. Unlike a mute, this is a purely
  // local decision of ONE viewer — the producer keeps sending and everybody
  // else keeps receiving, so we deliberately do NOT broadcast anything here.
  // -----------------------------------------------------------------------
  socket.on(
    'pauseConsumer',
    async (payload: PauseConsumerPayload, callback?: Callback<void>) => {
      const { roomId, peerId, consumerId, paused } = payload ?? {}

      try {
        const room = rooms.get(roomId)
        if (!room) {
          if (callback) return err(callback as Callback<never>, `Room ${roomId} not found`)
          return
        }

        if (paused) {
          await room.pauseConsumer(peerId, consumerId)
        } else {
          await room.resumeConsumer(peerId, consumerId)
        }
        if (callback) ack(callback, undefined)
      } catch (e) {
        if (callback) err(callback as Callback<never>, (e as Error).message)
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
