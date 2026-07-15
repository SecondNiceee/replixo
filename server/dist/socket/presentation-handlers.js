"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPresentationHandlers = registerPresentationHandlers;
const db_1 = require("../db");
const helpers_1 = require("./helpers");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// Presentation: slide sync + drawing annotations over slides
// ---------------------------------------------------------------------------
function registerPresentationHandlers(ctx) {
    const { io, socket } = ctx;
    // -----------------------------------------------------------------------
    // presentationSlide  (presenter changed the current slide)
    //
    // The client emits this every time the visible slide/page index changes.
    // The server stores the state on the Room (so latecomers get it on join)
    // and broadcasts it to every other peer in the room.
    // -----------------------------------------------------------------------
    // Sliding-window rate-limit: max 10 accepted events per second per socket.
    const allowSlideEvent = (0, helpers_1.createRateLimiter)(10, 1000);
    socket.on('presentationSlide', (payload) => {
        // --- Input validation ---
        // Accept unknown — Socket.io doesn't guarantee the incoming type.
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, slide, total } = payload;
        if (typeof rid !== 'string' || !rid)
            return;
        if (typeof pid !== 'string' || !pid)
            return;
        if (typeof slide !== 'number' || !Number.isFinite(slide) || slide < 0 ||
            typeof total !== 'number' || !Number.isFinite(total) || total < 1)
            return;
        const slideIndex = Math.floor(slide);
        const totalPages = Math.floor(total);
        if (slideIndex >= totalPages)
            return;
        // --- Auth: sender must own this peerId in this room ---
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        // --- Rate limit ---
        if (!allowSlideEvent())
            return;
        room.currentSlide = { peerId: pid, slide: slideIndex, total: totalPages };
        // Use io.to() for reliability — socket.to() is a no-op if the socket
        // has already left the room (e.g. mid-disconnect race).
        io.to(rid).emit('presentationSlideChanged', { peerId: pid, slide: slideIndex, total: totalPages });
    });
    // -----------------------------------------------------------------------
    // presentationEnded  (presenter closed the file / stopped presenting)
    //
    // Clears the Room's slide state and notifies everyone in the room.
    // -----------------------------------------------------------------------
    socket.on('presentationEnded', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid } = payload;
        if (typeof rid !== 'string' || !rid)
            return;
        if (typeof pid !== 'string' || !pid)
            return;
        const room = room_registry_1.rooms.get(rid);
        if (!room)
            return;
        // Auth: only the active presenter owning this socket may end the presentation.
        if (room.currentSlide == null || room.currentSlide.peerId !== pid)
            return;
        if (room_registry_1.peerSockets.get(pid) !== socket.id)
            return;
        room.currentSlide = null;
        // Use io.to() — consistent with handleLeave; works even if the socket
        // is mid-disconnect when stopPresentation fires.
        io.to(rid).emit('presentationEnded', { peerId: pid });
        console.log(`[presentation] Peer ${pid} ended presentation in room ${rid}`);
    });
    // -----------------------------------------------------------------------
    // Presentation drawing annotations
    //
    // presentationStroke — relay an incremental stroke to all other peers.
    // presentationDrawClear — clear drawing on a slide for everyone.
    // presentationDrawSnapshot — persist the full canvas snapshot for a slide.
    // -----------------------------------------------------------------------
    // Rate-limit: up to 300 stroke events/sec (drawing fires many events).
    const allowStrokeEvent = (0, helpers_1.createRateLimiter)(300, 1000);
    socket.on('presentationStroke', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, slideIndex, stroke } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0)
            return;
        if (stroke == null)
            return;
        if (!allowStrokeEvent())
            return;
        socket.to(rid).emit('presentationStroke', { peerId: pid, slideIndex, stroke });
    });
    socket.on('presentationDrawClear', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, slideIndex } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0)
            return;
        room.presentationDrawings.delete(slideIndex);
        // Persist: null means "cleared".
        void (0, db_1.savePresentationDrawing)(rid, slideIndex, null);
        socket.to(rid).emit('presentationDrawClear', { peerId: pid, slideIndex });
    });
    socket.on('presentationDrawSnapshot', (payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { roomId: rid, peerId: pid, slideIndex, snapshot } = payload;
        const room = (0, room_registry_1.authedRoom)(rid, pid, socket.id);
        if (!room)
            return;
        if (typeof slideIndex !== 'number' || !Number.isFinite(slideIndex) || slideIndex < 0)
            return;
        if (typeof snapshot !== 'string' || snapshot.length > 5000000)
            return;
        room.presentationDrawings.set(slideIndex, snapshot);
        void (0, db_1.savePresentationDrawing)(rid, slideIndex, snapshot);
        // No broadcast needed — snapshot is only for persistence + late joiners.
    });
}
