import type { Server as HttpServer } from 'http'
import type { Worker } from 'mediasoup/node/lib/types'
import { Server, Socket } from 'socket.io'
import { CLIENT_ORIGIN } from './config'
import type { HandlerContext, SocketSession } from './socket/helpers'
import { registerMediaHandlers } from './socket/media-handlers'
import { registerChatHandlers } from './socket/chat-handlers'
import { registerWhiteboardHandlers } from './socket/whiteboard-handlers'
import { registerPresentationHandlers } from './socket/presentation-handlers'
import { registerAnnotationHandlers } from './socket/annotation-handlers'
import { registerLifecycleHandlers } from './socket/lifecycle-handlers'
import { setupDmNamespace } from './dm/namespace'

// ---------------------------------------------------------------------------
// Socket.io setup — thin orchestrator.
//
// All event handlers live in ./socket/*, grouped by domain:
//   room-registry.ts         — in-memory room store, peer↔socket map, grace window
//   media-handlers.ts        — joinRoom, transports, produce/consume (mediasoup)
//   chat-handlers.ts         — chatMessage, chatRead
//   whiteboard-handlers.ts   — shared tldraw board events
//   presentation-handlers.ts — slide sync + drawing over slides
//   annotation-handlers.ts   — ephemeral drawing over screen share
//   lifecycle-handlers.ts    — rejoinProbe, leaveRoom, disconnect
//   helpers.ts               — ack/err, rate limiter, shared types
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

    // Track which room/peer this socket belongs to. Shared by reference across
    // all handler modules so join/rejoin/leave keep it in sync.
    const session: SocketSession = { roomId: null, peerId: null }
    const ctx: HandlerContext = { io, socket, session }

    registerMediaHandlers(ctx, worker)
    registerChatHandlers(ctx)
    registerWhiteboardHandlers(ctx)
    registerPresentationHandlers(ctx)
    registerAnnotationHandlers(ctx)
    registerLifecycleHandlers(ctx)
  })

  // Личные сообщения живут в отдельном namespace со своей аутентификацией
  // по сессии Better Auth. Корневой namespace (звонки) не затрагивается.
  setupDmNamespace(io)

  return io
}
