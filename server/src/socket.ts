import type { Server as HttpServer } from 'http'
import type { Worker } from 'mediasoup/node/lib/types'
import { Server, Socket } from 'socket.io'
import { CLIENT_ORIGIN } from './config'
import { Room } from './Room'
import { Peer } from './Peer'
import {
  saveMessage,
  getRoomMessages,
  deleteRoomMessages,
  saveReadMarker,
  getRoomReadMarkers,
  getWhiteboard,
  saveWhiteboard,
  savePresentationDrawing,
  getPresentationDrawings,
} from './db'
import { deleteRoomUploads } from './uploads'
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
  ChatMessagePayload,
  ChatReadPayload,
  WhiteboardOpenPayload,
  WhiteboardChangePayload,
  WhiteboardSnapshotPayload,
  PresentationStrokePayload,
  PresentationDrawClearPayload,
  PresentationDrawSnapshotPayload,
  AnnotationStrokePayload,
  AnnotationClearPayload,
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
  return Room.create(roomId, worker).then(async (room) => {
    rooms.set(roomId, room)
    console.log(`[room] Created room ${roomId}`)
    // Hydrate any persisted whiteboard state so a board drawn in a previous
    // session (e.g. before a server restart) is restored. No-op without DB.
    try {
      const wb = await getWhiteboard(roomId)
      room.whiteboardOpen = wb.open
      room.whiteboardSnapshot = wb.snapshot
    } catch {
      // Ignore — board simply starts empty.
    }
    // Hydrate presentation drawing annotations (рисунки поверх слайдов).
    try {
      const drawings = await getPresentationDrawings(roomId)
      room.presentationDrawings = drawings
    } catch {
      // Ignore — slides start empty.
    }
    return room
  })
}

function cleanupRoomIfEmpty(roomId: string): void {
  const room = rooms.get(roomId)
  if (room && room.isEmpty()) {
    room.close()
    rooms.delete(roomId)
    console.log(`[room] Removed empty room ${roomId}`)
    // Комната уничтожена — стираем всю историю её чата и файловые вложения с
    // диска. Fire-and-forget: удаление не должно блокировать поток сокета.
    void deleteRoomMessages(roomId)
    void deleteRoomUploads(roomId)
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

        return (payload: unknown) => {
          // --- Input validation ---
          // Accept unknown — Socket.io doesn't guarantee the incoming type.
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, slide, total } = payload as PresentationSlidePayload

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
          // Use io.to() for reliability �� socket.to() is a no-op if the socket
          // has already left the room (e.g. mid-disconnect race).
          io.to(rid).emit('presentationSlideChanged', { peerId: pid, slide: slideIndex, total: totalPages })
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
        // Use io.to() — consistent with handleLeave; works even if the socket
        // is mid-disconnect when stopPresentation fires.
        io.to(rid).emit('presentationEnded', { peerId: pid })
        console.log(`[presentation] Peer ${pid} ended presentation in room ${rid}`)
      },
    )

    // -----------------------------------------------------------------------
    // chatMessage  (a peer sent a text message to the room)
    //
    // The client emits this whenever a participant sends a message. The server
    // validates + authenticates the sender, rate-limits, assigns a canonical
    // id/timestamp and broadcasts to every OTHER peer in the room. The sender
    // adds its own message optimistically (mirrors the slide-sync pattern), so
    // we use socket.to() — not io.to() — to avoid echoing it back.
    // -----------------------------------------------------------------------
    socket.on(
      'chatMessage',
      (() => {
        // Sliding-window rate-limit: max 5 messages per 2 seconds per socket.
        const CHAT_RATE_LIMIT = 5
        const CHAT_RATE_WINDOW_MS = 2000
        const MAX_TEXT_LENGTH = 2000
        let chatEventCount = 0
        let chatWindowStart = Date.now()

        return (payload: unknown) => {
          // --- Input validation ---
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, text, id: clientId, attachment } = payload as ChatMessagePayload
          if (typeof rid !== 'string' || !rid) return
          if (typeof pid !== 'string' || !pid) return
          if (typeof text !== 'string') return

          const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)

          // --- Validate attachment (optional) ---
          // url должен указывать строго в папку вложений ЭТОЙ комнаты —
          // защита от подделки ссылок на чужие/произвольные файлы.
          let safeAttachment: ChatMessagePayload['attachment'] | undefined
          if (attachment != null) {
            if (typeof attachment !== 'object') return
            const { url, name, size, mime } = attachment
            const expectedPrefix = `/uploads/${rid}/`
            if (
              typeof url !== 'string' ||
              !url.startsWith(expectedPrefix) ||
              url.includes('..') ||
              typeof name !== 'string' ||
              typeof size !== 'number' ||
              !Number.isFinite(size) ||
              size < 0 ||
              typeof mime !== 'string'
            ) {
              return
            }
            safeAttachment = {
              url,
              name: name.slice(0, 255),
              size,
              mime: mime.slice(0, 128),
            }
          }

          // Сообщение должно нести хоть что-то: текст или вложение.
          if (!trimmed && !safeAttachment) return

          // --- Auth: sender must own this peerId in this room ---
          const room = rooms.get(rid)
          if (!room) return
          const peer = room.getPeer(pid)
          if (!peer) return
          if (peerSockets.get(pid) !== socket.id) return

          // --- Rate limit ---
          const now = Date.now()
          if (now - chatWindowStart > CHAT_RATE_WINDOW_MS) {
            chatEventCount = 0
            chatWindowStart = now
          }
          if (++chatEventCount > CHAT_RATE_LIMIT) return

          // Reuse the sender's client-generated id when it looks valid so the
          // optimistic copy and the persisted/broadcast record share one id.
          // Falls back to a server id otherwise.
          const id =
            typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64
              ? clientId
              : `${now}-${Math.random().toString(36).slice(2, 8)}`

          const message = {
            id,
            roomId: rid,
            peerId: pid,
            displayName: peer.displayName,
            text: trimmed,
            attachment: safeAttachment ?? null,
            timestamp: now,
          }

          // Persist (no-op when DATABASE_URL is unset). Fire-and-forget.
          void saveMessage(message)

          socket.to(rid).emit('chatMessage', {
            id: message.id,
            peerId: message.peerId,
            displayName: message.displayName,
            text: message.text,
            attachment: message.attachment,
            timestamp: message.timestamp,
          })
        }
      })(),
    )

    // -----------------------------------------------------------------------
    // chatRead  (a peer has read the chat up to a given timestamp)
    //
    // Emitted when the recipient has the chat panel open AND the tab visible.
    // We persist the marker (no-op without DATABASE_URL) and broadcast it to
    // the OTHER peers so senders can flip their messages to "read".
    // -----------------------------------------------------------------------
    socket.on('chatRead', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid, ts } = payload as ChatReadPayload
      if (typeof rid !== 'string' || !rid) return
      if (typeof pid !== 'string' || !pid) return
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return

      // --- Auth: sender must own this peerId in this room ---
      const room = rooms.get(rid)
      if (!room) return
      if (!room.hasPeer(pid)) return
      if (peerSockets.get(pid) !== socket.id) return

      // Persist (fire-and-forget) and tell the others.
      void saveReadMarker(rid, pid, ts)
      socket.to(rid).emit('chatRead', { peerId: pid, ts })
    })

    // -----------------------------------------------------------------------
    // Shared whiteboard (tldraw)
    //
    // whiteboardOpen / whiteboardClose toggle a room-wide flag so the board
    // appears/disappears for everyone at once. whiteboardChange relays a peer's
    // incremental tldraw store diff to the others for live drawing.
    // whiteboardSnapshot persists the full document (debounced by the client)
    // and keeps an in-memory copy so mid-session joiners load the current state.
    // -----------------------------------------------------------------------

    // Helper: validate sender + return the room they legitimately belong to.
    const authedRoom = (rid: unknown, pid: unknown): Room | null => {
      if (typeof rid !== 'string' || !rid) return null
      if (typeof pid !== 'string' || !pid) return null
      const room = rooms.get(rid)
      if (!room || !room.hasPeer(pid)) return null
      if (peerSockets.get(pid) !== socket.id) return null
      return room
    }

    socket.on('whiteboardOpen', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid } = payload as WhiteboardOpenPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      room.whiteboardOpen = true
      void saveWhiteboard(rid, { open: true })
      // Others open the board too; hand them the current snapshot (may be null).
      socket.to(rid).emit('whiteboardOpened', { peerId: pid, snapshot: room.whiteboardSnapshot })
    })

    socket.on('whiteboardClose', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid } = payload as WhiteboardOpenPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      room.whiteboardOpen = false
      void saveWhiteboard(rid, { open: false })
      socket.to(rid).emit('whiteboardClosed', { peerId: pid })
    })

    socket.on(
      'whiteboardChange',
      (() => {
        // Generous sliding-window limit: drawing fires many diffs per second, so
        // allow up to 240/sec before dropping to guard against a runaway client.
        const WB_RATE_LIMIT = 240
        const WB_RATE_WINDOW_MS = 1000
        let wbEventCount = 0
        let wbWindowStart = Date.now()

        return (payload: unknown) => {
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, changes } = payload as WhiteboardChangePayload
          const room = authedRoom(rid, pid)
          if (!room) return
          if (changes == null) return

          const now = Date.now()
          if (now - wbWindowStart > WB_RATE_WINDOW_MS) {
            wbEventCount = 0
            wbWindowStart = now
          }
          if (++wbEventCount > WB_RATE_LIMIT) return

          socket.to(rid).emit('whiteboardChange', { peerId: pid, changes })
        }
      })(),
    )

    socket.on('whiteboardSnapshot', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid, snapshot } = payload as WhiteboardSnapshotPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      // Cap snapshot size to avoid unbounded memory / DB rows from a bad client.
      if (typeof snapshot !== 'string' || snapshot.length > 5_000_000) return
      room.whiteboardSnapshot = snapshot
      void saveWhiteboard(rid, { snapshot })
    })

    // -----------------------------------------------------------------------
    // Presentation drawing annotations
    //
    // presentationStroke — relay an incremental stroke to all other peers.
    // presentationDrawClear — clear drawing on a slide for everyone.
    // presentationDrawSnapshot — persist the full canvas snapshot for a slide.
    // -----------------------------------------------------------------------

    socket.on(
      'presentationStroke',
      (() => {
        // Rate-limit: up to 300 stroke events/sec (drawing fires many events).
        const PD_RATE_LIMIT = 300
        const PD_RATE_WINDOW_MS = 1000
        let pdEventCount = 0
        let pdWindowStart = Date.now()

        return (payload: unknown) => {
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, slideIndex, stroke } = payload as PresentationStrokePayload
          const room = authedRoom(rid, pid)
          if (!room) return
          if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0) return
          if (stroke == null) return

          const now = Date.now()
          if (now - pdWindowStart > PD_RATE_WINDOW_MS) {
            pdEventCount = 0
            pdWindowStart = now
          }
          if (++pdEventCount > PD_RATE_LIMIT) return

          socket.to(rid).emit('presentationStroke', { peerId: pid, slideIndex, stroke })
        }
      })(),
    )

    socket.on('presentationDrawClear', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid, slideIndex } = payload as PresentationDrawClearPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0) return

      room.presentationDrawings.delete(slideIndex)
      // Persist: null means "cleared".
      void savePresentationDrawing(rid, slideIndex, null)
      socket.to(rid).emit('presentationDrawClear', { peerId: pid, slideIndex })
    })

    socket.on('presentationDrawSnapshot', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid, slideIndex, snapshot } = payload as PresentationDrawSnapshotPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0) return
      if (typeof snapshot !== 'string' || snapshot.length > 5_000_000) return

      room.presentationDrawings.set(slideIndex, snapshot)
      void savePresentationDrawing(rid, slideIndex, snapshot)
      // No broadcast needed — snapshot is only for persistence + late joiners.
    })

    // -----------------------------------------------------------------------
    // Screen-share annotations (рисование поверх демонстрации экрана)
    //
    // Эфемерные — НЕ персистятся: аннотации живут только пока идёт демонстрация.
    // annotationStroke транслирует один vector-штрих остальным участникам;
    // annotationClear стирает всё для всех. Координаты нормализованы клиентом.
    // -----------------------------------------------------------------------
    socket.on(
      'annotationStroke',
      (() => {
        // Rate-limit: рисование генерирует много событий — до 300/сек.
        const ANN_RATE_LIMIT = 300
        let annWindowStart = Date.now()
        let annEventCount = 0
        return (payload: unknown) => {
          if (!payload || typeof payload !== 'object') return
          const { roomId: rid, peerId: pid, stroke } = payload as AnnotationStrokePayload
          const room = authedRoom(rid, pid)
          if (!room) return
          if (stroke == null) return

          const now = Date.now()
          if (now - annWindowStart >= 1000) {
            annWindowStart = now
            annEventCount = 0
          }
          if (++annEventCount > ANN_RATE_LIMIT) return

          socket.to(rid).emit('annotationStroke', { peerId: pid, stroke })
        }
      })(),
    )

    socket.on('annotationClear', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { roomId: rid, peerId: pid } = payload as AnnotationClearPayload
      const room = authedRoom(rid, pid)
      if (!room) return
      socket.to(rid).emit('annotationClear', { peerId: pid })
    })

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
