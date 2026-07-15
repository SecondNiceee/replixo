"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLEAN_CLOSE_GRACE_MS = exports.CLOSE_GRACE_MS = exports.DISCONNECT_GRACE_MS = exports.peerSockets = exports.rooms = void 0;
exports.markClosing = markClosing;
exports.isClosing = isClosing;
exports.clearPendingDisconnect = clearPendingDisconnect;
exports.scheduleEviction = scheduleEviction;
exports.setPendingDisconnect = setPendingDisconnect;
exports.deletePendingDisconnect = deletePendingDisconnect;
exports.evictPeer = evictPeer;
exports.getOrCreateRoom = getOrCreateRoom;
exports.cleanupRoomIfEmpty = cleanupRoomIfEmpty;
exports.authedRoom = authedRoom;
const Room_1 = require("../Room");
const db_1 = require("../db");
const uploads_1 = require("../uploads");
// ---------------------------------------------------------------------------
// In-memory room store shared by all handler modules
// ---------------------------------------------------------------------------
exports.rooms = new Map();
// peerId → socketId — tracks where each peer is currently connected so we can
// kick an old tab when the same peer reconnects from a new one.
exports.peerSockets = new Map();
// peerId → pending-removal timer. When a socket drops (phone locks/backgrounds,
// Wi-Fi hand-off, tunnel switch) we DON'T evict the peer immediately. Instead we
// keep its producers/consumers/transports alive for a grace window so that when
// the device comes back it resumes via rejoinProbe + ICE restart and never
// "disappears" for the other participants. Only if it stays gone past the
// window do we actually remove it.
const pendingDisconnects = new Map();
// How long a peer may stay silently disconnected before we evict it. Mobile
// backgrounding / screen-lock can suspend the socket for a while, so we allow a
// generous window. 45 s comfortably covers a user briefly checking another app.
exports.DISCONNECT_GRACE_MS = 45000;
// Much shorter window used when the client explicitly told us it is going away
// (tab/browser closed or navigated away — signalled via a sendBeacon on
// `pagehide`/`beforeunload`). We don't evict *instantly* so that a page reload
// or an accidental quick return can still cancel the eviction via
// rejoinProbe/joinRoom, but 6 s means other participants see the person leave
// almost right away instead of waiting out the full grace window.
exports.CLOSE_GRACE_MS = 6000;
// Fallback window for a *clean* socket close that arrived WITHOUT a beacon.
// When a tab/browser is closed, the WebSocket is closed gracefully and Socket.io
// reports the disconnect reason as "transport close" / "client namespace
// disconnect" — this fires immediately, with no ping-timeout latency. The beacon
// is unreliable (it can be dropped on abrupt tab kills, some mobile browsers,
// blocked requests, Electron, etc.), so we must NOT depend on it: a clean close
// is itself strong evidence the user is gone. We still allow a small window so a
// page reload or a mobile WiFi↔4G hand-off (which can also surface as a clean
// close) has time to reconnect via rejoinProbe before we evict.
exports.CLEAN_CLOSE_GRACE_MS = 10000;
// peerIds that announced an intentional close. When such a peer's socket also
// drops we use CLOSE_GRACE_MS instead of DISCONNECT_GRACE_MS.
const closingPeers = new Set();
function markClosing(peerId) {
    closingPeers.add(peerId);
}
function isClosing(peerId) {
    return closingPeers.has(peerId);
}
function clearPendingDisconnect(peerId) {
    const t = pendingDisconnects.get(peerId);
    if (t) {
        clearTimeout(t);
        pendingDisconnects.delete(peerId);
    }
    // A (re)join or explicit leave voids any pending "closing" intent too.
    closingPeers.delete(peerId);
}
// Replace any pending eviction timer WITHOUT clearing the "closing" flag, so
// the disconnect and beacon paths can race in any order without stomping each
// other's intent.
function scheduleEviction(peerId, timer) {
    const existing = pendingDisconnects.get(peerId);
    if (existing)
        clearTimeout(existing);
    pendingDisconnects.set(peerId, timer);
}
function setPendingDisconnect(peerId, timer) {
    pendingDisconnects.set(peerId, timer);
}
function deletePendingDisconnect(peerId) {
    pendingDisconnects.delete(peerId);
}
/**
 * Remove a peer from its room and notify everyone. Safe to call without a
 * socket context (e.g. from a grace-window timer or the sendBeacon HTTP
 * endpoint). Idempotent: a no-op if the peer is no longer in the room.
 */
function evictPeer(io, roomId, peerId) {
    clearPendingDisconnect(peerId);
    const room = exports.rooms.get(roomId);
    if (!room || !room.hasPeer(peerId))
        return;
    // If the leaving peer was the presenter, clear slide state and notify.
    if (room.currentSlide?.peerId === peerId) {
        room.currentSlide = null;
        io.to(roomId).emit('presentationEnded', { peerId });
    }
    room.removePeer(peerId);
    io.to(roomId).emit('peerLeft', { peerId });
    exports.peerSockets.delete(peerId);
    console.log(`[room] Peer ${peerId} evicted from room ${roomId}`);
    cleanupRoomIfEmpty(roomId);
}
function getOrCreateRoom(roomId, worker) {
    if (exports.rooms.has(roomId))
        return Promise.resolve(exports.rooms.get(roomId));
    return Room_1.Room.create(roomId, worker).then(async (room) => {
        exports.rooms.set(roomId, room);
        console.log(`[room] Created room ${roomId}`);
        // Hydrate any persisted whiteboard state so a board drawn in a previous
        // session (e.g. before a server restart) is restored. No-op without DB.
        try {
            const wb = await (0, db_1.getWhiteboard)(roomId);
            room.whiteboardOpen = wb.open;
            room.whiteboardSnapshot = wb.snapshot;
        }
        catch {
            // Ignore — board simply starts empty.
        }
        // Hydrate presentation drawing annotations (рисунки поверх слайдов).
        try {
            const drawings = await (0, db_1.getPresentationDrawings)(roomId);
            room.presentationDrawings = drawings;
        }
        catch {
            // Ignore — slides start empty.
        }
        return room;
    });
}
function cleanupRoomIfEmpty(roomId) {
    const room = exports.rooms.get(roomId);
    if (room && room.isEmpty()) {
        room.close();
        exports.rooms.delete(roomId);
        console.log(`[room] Removed empty room ${roomId}`);
        // Комната уничтожена — стираем всю историю её чата и файловые вложения с
        // диска. Fire-and-forget: удаление не должно блокировать поток сокета.
        void (0, db_1.deleteRoomMessages)(roomId);
        void (0, uploads_1.deleteRoomUploads)(roomId);
    }
}
/**
 * Validate an incoming (roomId, peerId) pair against the sender's socket:
 * the room must exist, the peer must be in it, and the peerId must belong to
 * this exact socket. Returns the room on success, null otherwise.
 */
function authedRoom(rid, pid, socketId) {
    if (typeof rid !== 'string' || !rid)
        return null;
    if (typeof pid !== 'string' || !pid)
        return null;
    const room = exports.rooms.get(rid);
    if (!room || !room.hasPeer(pid))
        return null;
    if (exports.peerSockets.get(pid) !== socketId)
        return null;
    return room;
}
