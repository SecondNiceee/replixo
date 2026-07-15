"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWhiteboardHandlers = registerWhiteboardHandlers;
const db_1 = require("../db");
const helpers_1 = require("./helpers");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// Shared whiteboard (tldraw)
//
// whiteboardOpen / whiteboardClose toggle a room-wide flag so the board
// appears/disappears for everyone at once. whiteboardChange relays a peer's
// incremental tldraw store diff to the others for live drawing.
// whiteboardSnapshot persists the full document (debounced by the client)
// and keeps an in-memory copy so mid-session joiners load the current state.
// ---------------------------------------------------------------------------
function registerWhiteboardHandlers(ctx) {
    const { socket } = ctx;
    socket.on('whiteboardOpen', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        room.whiteboardOpen = true;
        void (0, db_1.saveWhiteboard)(rid, { open: true });
        // Others open the board too; hand them the current snapshot (may be null).
        socket.to(rid).emit('whiteboardOpened', { peerId: pid, snapshot: room.whiteboardSnapshot });
    });
    socket.on('whiteboardClose', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        room.whiteboardOpen = false;
        void (0, db_1.saveWhiteboard)(rid, { open: false });
        socket.to(rid).emit('whiteboardClosed', { peerId: pid });
    });
    // Generous sliding-window limit: drawing fires many diffs per second, so
    // allow up to 240/sec before dropping to guard against a runaway client.
    const allowWhiteboardChange = (0, helpers_1.createRateLimiter)(240, 1000);
    socket.on('whiteboardChange', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, changes } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        if (changes == null)
            return;
        if (!allowWhiteboardChange())
            return;
        socket.to(rid).emit('whiteboardChange', { peerId: pid, changes });
    });
    socket.on('whiteboardSnapshot', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, snapshot } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        // Cap snapshot size to avoid unbounded memory / DB rows from a bad client.
        if (typeof snapshot !== 'string' || snapshot.length > 5000000)
            return;
        room.whiteboardSnapshot = snapshot;
        void (0, db_1.saveWhiteboard)(rid, { snapshot });
    });
}
