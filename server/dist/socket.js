"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketIO = setupSocketIO;
const socket_io_1 = require("socket.io");
const config_1 = require("./config");
const media_handlers_1 = require("./socket/media-handlers");
const chat_handlers_1 = require("./socket/chat-handlers");
const whiteboard_handlers_1 = require("./socket/whiteboard-handlers");
const presentation_handlers_1 = require("./socket/presentation-handlers");
const annotation_handlers_1 = require("./socket/annotation-handlers");
const lifecycle_handlers_1 = require("./socket/lifecycle-handlers");
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
function setupSocketIO(httpServer, worker) {
    const io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: config_1.CLIENT_ORIGIN,
            methods: ['GET', 'POST'],
        },
        // Give the client enough time to survive a ~5-second transient network
        // drop (VPN toggle, Wi-Fi hand-off) without being treated as disconnected.
        // Default pingTimeout is 20 s — raising it to 30 s and keeping pingInterval
        // at 10 s means three missed pings before the server gives up.
        pingTimeout: 30000,
        pingInterval: 10000,
    });
    io.on('connection', (socket) => {
        console.log(`[socket] Client connected: ${socket.id}`);
        // Track which room/peer this socket belongs to. Shared by reference across
        // all handler modules so join/rejoin/leave keep it in sync.
        const session = { roomId: null, peerId: null };
        const ctx = { io, socket, session };
        (0, media_handlers_1.registerMediaHandlers)(ctx, worker);
        (0, chat_handlers_1.registerChatHandlers)(ctx);
        (0, whiteboard_handlers_1.registerWhiteboardHandlers)(ctx);
        (0, presentation_handlers_1.registerPresentationHandlers)(ctx);
        (0, annotation_handlers_1.registerAnnotationHandlers)(ctx);
        (0, lifecycle_handlers_1.registerLifecycleHandlers)(ctx);
    });
    return io;
}
