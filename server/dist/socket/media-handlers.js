"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMediaHandlers = registerMediaHandlers;
const Peer_1 = require("../Peer");
const db_1 = require("../db");
const helpers_1 = require("./helpers");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// WebRTC / mediasoup signalling: joinRoom, transports, produce/consume
// ---------------------------------------------------------------------------
function registerMediaHandlers(ctx, worker) {
    const { io, socket, session } = ctx;
    // -----------------------------------------------------------------------
    // joinRoom
    // -----------------------------------------------------------------------
    socket.on('joinRoom', async (payload, callback) => {
        const { roomId, peerId, displayName, rtpCapabilities, create } = payload;
        try {
            if (!create && !room_registry_1.rooms.has(roomId)) {
                return (0, helpers_1.err)(callback, 'Комната не найдена');
            }
            const existingSocketId = (0, room_registry_1.getPeerSocket)(roomId, peerId);
            if (existingSocketId && existingSocketId !== socket.id) {
                const oldSocket = io.sockets.sockets.get(existingSocketId);
                if (oldSocket?.connected) {
                    // A genuine duplicate session in this room. Independent tabs now
                    // have different peer IDs, so this only handles an actual clone.
                    oldSocket.emit('kicked', { reason: 'duplicate' });
                    oldSocket.disconnect(true);
                }
                (0, room_registry_1.evictPeer)(io, roomId, peerId, existingSocketId);
            }
            (0, room_registry_1.clearPendingDisconnect)(roomId, peerId);
            const room = await (0, room_registry_1.getOrCreateRoom)(roomId, worker);
            if (room.isFull())
                return (0, helpers_1.err)(callback, 'Room is full (max 5 participants)');
            const peer = new Peer_1.Peer({ peerId, displayName, socketId: socket.id });
            peer.rtpCapabilities = rtpCapabilities;
            room.addPeer(peer);
            session.roomId = roomId;
            session.peerId = peerId;
            (0, room_registry_1.setPeerSocket)(roomId, peerId, socket.id);
            socket.join(roomId);
            const existingPeers = room.getExistingPeersFor(peerId);
            console.log(`[room] Peer ${peerId} (${displayName}) joined room ${roomId} — peers: ${room.getPeerIds().length}`);
            // Notify other peers that someone joined, even before they produce media
            socket.to(roomId).emit('peerJoined', { peerId, displayName });
            // Load persisted chat history so the joining peer (or someone who just
            // reloaded the page) sees prior messages. Empty when persistence is off.
            const messages = await (0, db_1.getRoomMessages)(roomId);
            // Read markers of every participant so checkmarks render correctly on
            // already-sent messages right after joining/reloading.
            const readMarkers = await (0, db_1.getRoomReadMarkers)(roomId);
            // Serialize presentationDrawings Map → plain object for JSON transport.
            const presentationDrawings = {};
            for (const [idx, snap] of room.presentationDrawings.entries()) {
                presentationDrawings[String(idx)] = snap;
            }
            (0, helpers_1.ack)(callback, {
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
            });
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // createWebRtcTransport
    // -----------------------------------------------------------------------
    socket.on('createWebRtcTransport', async (payload, callback) => {
        const { roomId, peerId, direction } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            const transportData = await room.createWebRtcTransport(peerId, direction ?? 'send');
            (0, helpers_1.ack)(callback, transportData);
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // connectTransport
    // -----------------------------------------------------------------------
    socket.on('connectTransport', async (payload, callback) => {
        const { roomId, peerId, transportId, dtlsParameters } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            await room.connectTransport(peerId, transportId, dtlsParameters);
            (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // restartIce  (called by client when transport ICE state => disconnected/failed)
    // -----------------------------------------------------------------------
    socket.on('restartIce', async (payload, callback) => {
        const { roomId, peerId, transportId } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            const iceParameters = await room.restartIce(peerId, transportId);
            (0, helpers_1.ack)(callback, iceParameters);
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // produce
    // -----------------------------------------------------------------------
    socket.on('produce', async (payload, callback) => {
        const { roomId, peerId, transportId, kind, rtpParameters, appData = {} } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            const peer = room.getPeer(peerId);
            if (!peer)
                return (0, helpers_1.err)(callback, `Peer ${peerId} not found`);
            const result = await room.produce(peerId, transportId, kind, rtpParameters, appData);
            // Notify all other peers in the room about the new producer
            socket.to(roomId).emit('newProducer', {
                peerId,
                displayName: peer.displayName,
                producerId: result.producerId,
                kind,
                appData,
            });
            (0, helpers_1.ack)(callback, { producerId: result.producerId });
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // consume
    // -----------------------------------------------------------------------
    socket.on('consume', async (payload, callback) => {
        const { roomId, peerId, producerId, rtpCapabilities } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            const consumerData = await room.consume(peerId, producerId, rtpCapabilities);
            (0, helpers_1.ack)(callback, consumerData);
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // resumeConsumer
    // -----------------------------------------------------------------------
    socket.on('resumeConsumer', async (payload, callback) => {
        const { roomId, peerId, consumerId } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            await room.resumeConsumer(peerId, consumerId);
            (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // requestConsumerKeyFrame  (client-driven black-frame recovery)
    //
    // Emitted by a viewer whose video consumer has resumed but is still showing
    // a black frame (no decoded frames yet). We push a fresh keyframe on demand;
    // the client keeps asking until its decoder actually produces a picture.
    // -----------------------------------------------------------------------
    socket.on('requestConsumerKeyFrame', async (payload, callback) => {
        const { roomId, peerId, consumerId } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room) {
                if (callback)
                    return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
                return;
            }
            await room.requestConsumerKeyFrame(peerId, consumerId);
            if (callback)
                (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            if (callback)
                (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // closeProducer  (e.g. stop screen sharing)
    // -----------------------------------------------------------------------
    socket.on('closeProducer', (payload, callback) => {
        const { roomId, peerId, producerId } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room) {
                if (callback)
                    return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
                return;
            }
            room.closeProducer(peerId, producerId);
            socket.to(roomId).emit('producerClosed', { peerId, producerId });
            if (callback)
                (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            if (callback)
                (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // pauseProducer / resumeProducer  (e.g. mute / unmute microphone)
    // -----------------------------------------------------------------------
    socket.on('pauseProducer', async (payload, callback) => {
        const { roomId, peerId, producerId, paused } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room) {
                if (callback)
                    return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
                return;
            }
            if (paused) {
                await room.pauseProducer(peerId, producerId);
            }
            else {
                await room.resumeProducer(peerId, producerId);
            }
            // Inform other peers so they can update UI (e.g. mute indicator)
            socket.to(roomId).emit('producerPaused', { peerId, producerId, paused });
            if (callback)
                (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            if (callback)
                (0, helpers_1.err)(callback, e.message);
        }
    });
}
