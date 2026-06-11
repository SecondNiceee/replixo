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
  PresentationSlidePayload,
} from './types'

// ---------------------------------------------------------------------------
// In-memory room store
// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>()

// peerId → socketId — tracks where each peer is currently connected so we can
// kick an old tab when the same peer reconnects from a new one.
const peerSockets = new Map<string, string>()

// peerId → pending-removal timer. When a socket drops (phone locks/backgrounds,
// Wi-Fi hand-off, tunnel switch) we DON'T evict the peer immediately. Instead we
// keep its producers/consumers/transports alive for a grace window so that when
// the device comes back it resumes via rejoinProbe + ICE restart and never
// "disappears" for the other participants. Only if it stays gone past the
// window do we actually remove it.
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>()

// How long a peer may stay silently disconnected before we evict it. Mobile
// backgrounding / screen-lock can suspend the socket for a while, so we allow a
// generous window. 45 s comfortably covers a user briefly checking another app.
const DISCONNECT_GRACE_MS = 45000

function clearPendingDisconnect(peerId: string): void {
  const t = pendingDisconnects.get(peerId)
  if (t) {
    clearTimeout(t)
    pendingDisconnects.delete(peerId)
  }
}

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

          currentRoomId = roomId
          currentPeerId = peerId
          peerSockets.set(peerId, socket.id)
          socket.join(roomId)

          const existingPeers = room.getExistingPeersFor(peerId)
          console.log(`[room] Peer ${peerId} (${displayName}) joined room ${roomId} — peers: ${room.getPeerIds().length}`)

          // Notify other peers that someone joined, even before they produce media
          socket.to(roomId).emit('peerJoined', { peerId, displayName })

          ack(callback, {
            rtpCapabilities: room.getRtpCapabilities(),
            existingPeers,
            currentSlide: room.currentSlide ?? null,
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
    // presentationSlide  (presenter changed the current slide)
    //
    // The client emits this every time the visible slide/page index changes.
    // The server stores the state on the Room (so latecomers get it on join)
    // and broadcasts it to every other peer in the room.
    // -----------------------------------------------------------------------

    socket.on(
      'presentationSlide',
      (() => {
        // Sliding-window rate-limit: max 10 accepted events per second per socket.
        // Declared inside an IIFE so the counters are scoped only to this handler.
        const SLIDE_RATE_LIMIT = 10
        const SLIDE_RATE_WINDOW_MS = 1000
        let slideEventCount = 0
        let slideWindowStart = Date.now()

        return (payload: PresentationSlidePayload) => {
          // --- Input validation ---
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, slide, total } = payload

          if (typeof rid !== 'string' || !rid) return
          if (typeof pid !== 'string' || !pid) return
          if (
            typeof slide !== 'number' || !Number.isFinite(slide) || slide < 0 ||
            typeof total !== 'number' || !Number.isFinite(total) || total < 1
          ) return

          const slideIndex = Math.floor(slide)
          const totalPages = Math.floor(total)
          if (slideIndex >= totalPages) return

          // --- Auth: sender must own this peerId in this room ---
          const room = rooms.get(rid)
          if (!room) return
          if (!room.hasPeer(pid)) return
          if (peerSockets.get(pid) !== socket.id) return

          // --- Rate limit (fixed: > not >=, so exactly LIMIT events pass) ---
          const now = Date.now()
          if (now - slideWindowStart > SLIDE_RATE_WINDOW_MS) {
            slideEventCount = 0
            slideWindowStart = now
          }
          if (++slideEventCount > SLIDE_RATE_LIMIT) return

          room.currentSlide = { peerId: pid, slide: slideIndex, total: totalPages }
          socket.to(rid).emit('presentationSlideChanged', { peerId: pid, slide: slideIndex, total: totalPages })
        }
      })(),
    )

    // -----------------------------------------------------------------------
    // presentationEnded  (presenter closed the file / stopped presenting)
    //
    // Clears the Room's slide state and notifies everyone in the room.
    // -----------------------------------------------------------------------
    socket.on(
      'presentationEnded',
      (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return
        const { roomId: rid, peerId: pid } = payload as Record<string, unknown>

        if (typeof rid !== 'string' || !rid) return
        if (typeof pid !== 'string' || !pid) return

        const room = rooms.get(rid)
        if (!room) return

        // Auth: only the active presenter owning this socket may end the presentation.
        if (room.currentSlide == null || room.currentSlide.peerId !== pid) return
        if (peerSockets.get(pid) !== socket.id) return

        room.currentSlide = null
        socket.to(rid).emit('presentationEnded', { peerId: pid })
        console.log(`[presentation] Peer ${pid} ended presentation in room ${rid}`)
      },
    )

    // -----------------------------------------------------------------------
    // rejoinProbe — client checks whether the server still has the peer after
    // a socket.io reconnect. Returns null if the peer is still in the room,
    // or an error string if it was evicted (so the client can do a full rejoin).
    // -----------------------------------------------------------------------
    socket.on(
      'rejoinProbe',
      ({ roomId, peerId }: { roomId: string; peerId: string }, callback: Callback<void>) => {
        const room = rooms.get(roomId)
        if (!room || !room.hasPeer(peerId)) {
          return err(callback as Callback<never>, 'peer evicted')
        }
        // The peer is back on a fresh socket within the grace window — cancel the
        // pending eviction and re-bind it to this socket so media keeps flowing.
        clearPendingDisconnect(peerId)
        // Re-join the socket.io room: after a reconnect this is a brand-new
        // socket, so without this it would miss peerJoined/newProducer/etc.
        socket.join(roomId)
        currentRoomId = roomId
        currentPeerId = peerId
        // Update the socket mapping in case the socket.id changed on reconnect.
        peerSockets.set(peerId, socket.id)
        ack(callback, undefined)
      },
    )

    // -----------------------------------------------------------------------
    // leaveRoom  (explicit)
    // -----------------------------------------------------------------------
    socket.on('leaveRoom', ({ roomId, peerId }: { roomId: string; peerId: string }) => {
      handleLeave(roomId, peerId)
    })

    // -----------------------------------------------------------------------
    // disconnect  (implicit) — DO NOT evict immediately.
    //
    // A dropped socket usually means the phone locked/backgrounded or the
    // network hiccupped, not that the user left. Removing the peer right away is
    // exactly what made people "disappear and never come back". Instead we keep
    // the peer (and all its producers/consumers) alive for a grace window. If
    // the same peer reconnects (rejoinProbe / joinRoom) within that window we
    // cancel the eviction and media resumes seamlessly. Only if it never comes
    // back do we finally remove it.
    // -----------------------------------------------------------------------
    socket.on('disconnect', () => {
      console.log(`[socket] Client disconnected: ${socket.id}`)
      if (!currentRoomId || !currentPeerId) return

      const roomId = currentRoomId
      const peerId = currentPeerId

      // If a newer socket already took over this peerId (duplicate-tab kick or a
      // fast reconnect), this stale socket must not touch the peer at all.
      if (peerSockets.get(peerId) !== socket.id) return

      clearPendingDisconnect(peerId)
      const timer = setTimeout(() => {
        pendingDisconnects.delete(peerId)
        // Re-check: the peer may have reconnected on a new socket meanwhile.
        if (peerSockets.get(peerId) !== socket.id) return
        console.log(`[room] Peer ${peerId} did not return within grace window — evicting`)
        handleLeave(roomId, peerId)
      }, DISCONNECT_GRACE_MS)
      pendingDisconnects.set(peerId, timer)
    })

    // -----------------------------------------------------------------------
    // Internal helper
    // -----------------------------------------------------------------------
    function handleLeave(roomId: string, peerId: string): void {
      // An explicit leave (or grace-window expiry) supersedes any pending timer.
      clearPendingDisconnect(peerId)

      const room = rooms.get(roomId)
      if (!room) return

      // If the leaving peer was the presenter, clear the slide state and notify.
      // Use io.to() instead of socket.to() — handleLeave may be called from a
      // grace-window setTimeout after the socket has already disconnected and
      // left the room, in which case socket.to() would be a no-op.
      if (room.currentSlide?.peerId === peerId) {
        room.currentSlide = null
        io.to(roomId).emit('presentationEnded', { peerId })
      }

      room.removePeer(peerId)
      io.to(roomId).emit('peerLeft', { peerId })
      socket.leave(roomId)

      // Only clear the global peerSockets entry if this socket is still the
      // authoritative one for that peerId (it won't be if a new tab already
      // took over via the kick-duplicate logic above).
      if (peerSockets.get(peerId) === socket.id) {
        peerSockets.delete(peerId)
      }

      console.log(`[room] Peer ${peerId} left room ${roomId}`)
      cleanupRoomIfEmpty(roomId)

      currentRoomId = null
      currentPeerId = null
    }
  })

  return io
}
