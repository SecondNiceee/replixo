import type { Server as HttpServer } from 'http'
import type { Worker } from 'mediasoup/node/lib/types'
import { Server, Socket } from 'socket.io'
import { CLIENT_ORIGIN } from './config'
import { Room } from './Room'
import { Peer } from './Peer'
import type {
  JoinRoomPayload,
  CreateTransportPayload,
  ConnectTransportPayload,
  ProducePayload,
  ConsumePayload,
  ResumeConsumerPayload,
  CloseProducerPayload,
  PauseProducerPayload,
} from './types'

// ---------------------------------------------------------------------------
// In-memory room store
// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>()

function getOrCreateRoom(roomId: string, worker: Worker): Promise<Room> {
  if (rooms.has(roomId)) return Promise.resolve(rooms.get(roomId)!)
  return Room.create(roomId, worker).then((room) => {
    rooms.set(roomId, room)
    console.log(`[room] Created room ${roomId}`)
    return room
  })
}

function cleanupRoomIfEmpty(roomId: string): void {
  const room = rooms.get(roomId)
  if (room && room.isEmpty()) {
    room.close()
    rooms.delete(roomId)
    console.log(`[room] Removed empty room ${roomId}`)
  }
}

// ---------------------------------------------------------------------------
// Helper: emit typed events
// ---------------------------------------------------------------------------

type Callback<T = void> = (err: string | null, data?: T) => void

function ack<T>(cb: Callback<T>, data: T): void {
  cb(null, data)
}

function err(cb: Callback<never>, message: string): void {
  console.error(`[socket] Error: ${message}`)
  cb(message)
}

// ---------------------------------------------------------------------------
// Socket.io setup
// ---------------------------------------------------------------------------

export function setupSocketIO(httpServer: HttpServer, worker: Worker): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: CLIENT_ORIGIN,
      methods: ['GET', 'POST'],
    },
    // Give the client enough time to survive a ~5-second transient network
    // drop (VPN toggle, Wi-Fi hand-off) without being treated as disconnected.
    // Default pingTimeout is 20 s — raising it to 30 s and keeping pingInterval
    // at 10 s means three missed pings before the server gives up.
    pingTimeout: 30000,
    pingInterval: 10000,
  })

  io.on('connection', (socket: Socket) => {
    console.log(`[socket] Client connected: ${socket.id}`)

    // Track which room this socket is in so we can clean up on disconnect
    let currentRoomId: string | null = null
    let currentPeerId: string | null = null

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

          const room = await getOrCreateRoom(roomId, worker)

          if (room.isFull()) return err(callback as Callback<never>, 'Room is full (max 5 participants)')
          if (room.hasPeer(peerId)) return err(callback as Callback<never>, `Peer ${peerId} already in room`)

          const peer = new Peer({ peerId, displayName, socketId: socket.id })
          peer.rtpCapabilities = rtpCapabilities
          room.addPeer(peer)

          currentRoomId = roomId
          currentPeerId = peerId
          socket.join(roomId)

          const existingPeers = room.getExistingPeersFor(peerId)
          console.log(`[room] Peer ${peerId} (${displayName}) joined room ${roomId} — peers: ${room.getPeerIds().length}`)

          // Notify other peers that someone joined, even before they produce media
          socket.to(roomId).emit('peerJoined', { peerId, displayName })

          ack(callback, {
            rtpCapabilities: room.getRtpCapabilities(),
            existingPeers,
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

    // -----------------------------------------------------------------------
    // leaveRoom  (explicit)
    // -----------------------------------------------------------------------
    socket.on('leaveRoom', ({ roomId, peerId }: { roomId: string; peerId: string }) => {
      handleLeave(roomId, peerId)
    })

    // -----------------------------------------------------------------------
    // disconnect  (implicit)
    // -----------------------------------------------------------------------
    socket.on('disconnect', () => {
      console.log(`[socket] Client disconnected: ${socket.id}`)
      if (currentRoomId && currentPeerId) {
        handleLeave(currentRoomId, currentPeerId)
      }
    })

    // -----------------------------------------------------------------------
    // Internal helper
    // -----------------------------------------------------------------------
    function handleLeave(roomId: string, peerId: string): void {
      const room = rooms.get(roomId)
      if (!room) return

      room.removePeer(peerId)
      socket.to(roomId).emit('peerLeft', { peerId })
      socket.leave(roomId)

      console.log(`[room] Peer ${peerId} left room ${roomId}`)
      cleanupRoomIfEmpty(roomId)

      currentRoomId = null
      currentPeerId = null
    }
  })

  return io
}
