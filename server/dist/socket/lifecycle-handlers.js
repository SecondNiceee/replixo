"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLifecycleHandlers = registerLifecycleHandlers;
const helpers_1 = require("./helpers");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// Connection lifecycle: rejoinProbe, leaveRoom, disconnect (+ grace window)
// ---------------------------------------------------------------------------
function registerLifecycleHandlers(ctx) {
    const { io, socket, session } = ctx;
    // -----------------------------------------------------------------------
    // Internal helper — remove a peer from its room and notify everyone.
    // The heavy lifting (presenter cleanup, peerLeft broadcast, peerSockets +
    // room cleanup) lives in evictPeer so the sendBeacon HTTP endpoint and the
    // grace-window timers can reuse the exact same logic.
    // -----------------------------------------------------------------------
    function handleLeave(roomId, peerId) {
        (0, room_registry_1.evictPeer)(io, roomId, peerId);
        socket.leave(roomId);
        session.roomId = null;
        session.peerId = null;
    }
    // -----------------------------------------------------------------------
    // rejoinProbe — client checks whether the server still has the peer after
    // a socket.io reconnect. Returns null if the peer is still in the room,
    // or an error string if it was evicted (so the client can do a full rejoin).
    // -----------------------------------------------------------------------
    socket.on('rejoinProbe', ({ roomId, peerId }, callback) => {
        const room = room_registry_1.rooms.get(roomId);
        if (!room || !room.hasPeer(peerId)) {
            return (0, helpers_1.err)(callback, 'peer evicted');
        }
        const previousSocketId = (0, room_registry_1.getPeerSocket)(roomId, peerId);
        const previousSocket = previousSocketId
            ? io.sockets.sockets.get(previousSocketId)
            : undefined;
        if (previousSocketId !== socket.id && previousSocket?.connected) {
            return (0, helpers_1.err)(callback, 'peer is active on another socket');
        }
        // Bind the new generation before cancelling eviction. Every delayed
        // callback checks this mapping and therefore cannot remove this session.
        (0, room_registry_1.setPeerSocket)(roomId, peerId, socket.id);
        (0, room_registry_1.clearPendingDisconnect)(roomId, peerId);
        socket.join(roomId);
        session.roomId = roomId;
        session.peerId = peerId;
        (0, helpers_1.ack)(callback, undefined);
    });
    // -----------------------------------------------------------------------
    // leaveRoom  (explicit)
    // -----------------------------------------------------------------------
    socket.on('leaveRoom', ({ roomId, peerId }) => {
        handleLeave(roomId, peerId);
    });
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
    socket.on('disconnect', (reason) => {
        console.log(`[socket] Client disconnected: ${socket.id} (${reason})`);
        if (!session.roomId || !session.peerId)
            return;
        const roomId = session.roomId;
        const peerId = session.peerId;
        // If a newer socket already took over this peerId (duplicate-tab kick or a
        // fast reconnect), this stale socket must not touch the peer at all.
        if ((0, room_registry_1.getPeerSocket)(roomId, peerId) !== socket.id)
            return;
        // Choose how long to wait before evicting, most-decisive signal first:
        //
        //  1. Beacon received  -> the client positively told us it's closing.
        //     Shortest window (CLOSE_GRACE_MS).
        //  2. Clean socket close ("transport close" / a namespace disconnect) that
        //     arrived with no ping-timeout latency -> the tab was almost certainly
        //     closed/navigated away, even though no beacon made it. Short window
        //     (CLEAN_CLOSE_GRACE_MS) so the other participants don't hang for a
        //     minute, while still leaving room for a reload / network hand-off to
        //     reconnect. This is the fix for "closed tab lingers ~2 min".
        //  3. Anything else ("ping timeout", "transport error") -> looks like a
        //     real network drop / phone lock. Keep the generous grace so a brief
        //     outage doesn't kick the user (DISCONNECT_GRACE_MS).
        // `transport close` is also emitted for Wi-Fi/VPN hand-offs, browser
        // process suspension and Electron network changes. Treat it as a network
        // interruption unless an explicit leave beacon marked the session closing.
        const graceMs = (0, room_registry_1.isClosing)(roomId, peerId) ? room_registry_1.CLOSE_GRACE_MS : room_registry_1.DISCONNECT_GRACE_MS;
        const timer = setTimeout(() => {
            (0, room_registry_1.deletePendingDisconnect)(roomId, peerId);
            if ((0, room_registry_1.getPeerSocket)(roomId, peerId) !== socket.id)
                return;
            console.log(`[room] Peer ${peerId} did not return within grace window — evicting`);
            (0, room_registry_1.evictPeer)(io, roomId, peerId, socket.id);
        }, graceMs);
        (0, room_registry_1.scheduleEviction)(roomId, peerId, timer);
    });
}
