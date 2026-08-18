"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMediaHandlers = registerMediaHandlers;
const Peer_1 = require("../Peer");
const db_1 = require("../db");
const helpers_1 = require("./helpers");
const room_code_1 = require("../room-code");
const room_registry_1 = require("./room-registry");
// ---------------------------------------------------------------------------
// WebRTC / mediasoup signalling: joinRoom, transports, produce/consume
// ---------------------------------------------------------------------------
/**
 * Ограничить время ожидания промиса. Нужно, чтобы ни один `await` в обработчике
 * joinRoom не мог заблокировать отправку ack: пока ack не отправлен, клиент
 * висит на экране «Подключение к комнате» без каких-либо признаков ошибки.
 */
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
/**
 * То же, но для некритичных данных: при таймауте/ошибке возвращаем fallback и
 * пускаем участника в комнату. Отсутствие истории чата — это деградация, а не
 * причина не пустить человека в звонок.
 */
async function optional(promise, ms, label, fallback) {
    try {
        return await withTimeout(promise, ms, label);
    }
    catch (e) {
        console.error(`[room] ${label} failed, продолжаем без него:`, e.message);
        return fallback;
    }
}
function registerMediaHandlers(ctx, worker) {
    const { io, socket, session } = ctx;
    // -----------------------------------------------------------------------
    // joinRoom
    // -----------------------------------------------------------------------
    socket.on('joinRoom', async (payload, callback) => {
        const { peerId, displayName, rtpCapabilities, create, clientId } = payload ?? {};
        const roomId = (0, room_code_1.canonicalRoomCode)(payload?.roomId);
        try {
            if (!roomId || typeof peerId !== 'string' || !peerId || typeof displayName !== 'string' || !displayName.trim()) {
                return (0, helpers_1.err)(callback, 'Некорректные данные подключения');
            }
            // Комната ещё не поднята — пускаем только того, кто пришёл её создавать,
            // либо по коду, который сервер сам выдал под звонок (там «создателя»
            // нет: оба участника просто идут по ссылке, и кто успел первым, тот и
            // поднимает комнату).
            if (!create && !room_registry_1.rooms.has(roomId) && !(0, room_registry_1.isRoomCreationAllowed)(roomId)) {
                return (0, helpers_1.err)(callback, 'Комната не найдена');
            }
            if (session.roomId && session.peerId && (session.roomId !== roomId || session.peerId !== peerId)) {
                (0, room_registry_1.evictPeer)(io, session.roomId, session.peerId, socket.id);
                socket.leave(session.roomId);
                session.roomId = null;
                session.peerId = null;
            }
            const existingSocketId = (0, room_registry_1.getPeerSocket)(roomId, peerId);
            if (existingSocketId && existingSocketId !== socket.id) {
                const oldSocket = io.sockets.sockets.get(existingSocketId);
                // The same page instance reconnecting (network hand-off, sleep/wake)
                // sends the same clientId. That must never be treated as a clone,
                // otherwise the client kicks itself out of the room it is recovering
                // into — and `kicked` is terminal on the client.
                const sameClient = !!clientId && (0, room_registry_1.getPeerClient)(roomId, peerId) === clientId;
                if (oldSocket?.connected && !sameClient) {
                    // Genuine duplicate: the same browser profile opened this room a
                    // second time (extra tab/window). peerId is derived from a
                    // persistent device id, so the stale session is kicked here instead
                    // of becoming a second participant that takes a slot and fights
                    // over producers.
                    console.warn(`[room] Duplicate session kicked room=${roomId} peer=${peerId} oldSocket=${existingSocketId} newSocket=${socket.id}`);
                    oldSocket.emit('kicked', { reason: 'duplicate' });
                    oldSocket.disconnect(true);
                }
                else if (oldSocket?.connected) {
                    // Same page, new socket: drop the stale transport silently, no kick.
                    console.info(`[room] Reconnect takeover room=${roomId} peer=${peerId} oldSocket=${existingSocketId} newSocket=${socket.id}`);
                    oldSocket.disconnect(true);
                }
                (0, room_registry_1.evictPeer)(io, roomId, peerId, existingSocketId);
            }
            (0, room_registry_1.clearPendingDisconnect)(roomId, peerId);
            // Создание комнаты поднимает mediasoup-router и подтягивает состояние
            // доски из БД. Если worker мёртв или база висит, промис может не
            // зарезолвиться никогда — ограничиваем и отвечаем ошибкой, чтобы клиент
            // показал её вместо бесконечного спиннера.
            const room = await withTimeout((0, room_registry_1.getOrCreateRoom)(roomId, worker), 15000, 'getOrCreateRoom');
            const repeatedJoin = room.hasPeer(peerId) && (0, room_registry_1.getPeerSocket)(roomId, peerId) === socket.id;
            if (!repeatedJoin && room.isFull())
                return (0, helpers_1.err)(callback, 'Room is full (max 5 participants)');
            if (repeatedJoin) {
                const peer = room.getPeer(peerId);
                peer.displayName = displayName.trim();
                peer.rtpCapabilities = rtpCapabilities;
            }
            else {
                const peer = new Peer_1.Peer({ peerId, displayName: displayName.trim(), socketId: socket.id });
                peer.rtpCapabilities = rtpCapabilities;
                room.addPeer(peer);
            }
            session.roomId = roomId;
            session.peerId = peerId;
            (0, room_registry_1.setPeerSocket)(roomId, peerId, socket.id);
            (0, room_registry_1.setPeerClient)(roomId, peerId, typeof clientId === 'string' ? clientId : undefined);
            socket.join(roomId);
            const existingPeers = room.getExistingPeersFor(peerId);
            console.log(`[room] ${repeatedJoin ? 'Repeated join ignored for' : 'Peer joined'} room=${roomId} peer=${peerId} socket=${socket.id} peers=${room.getPeerIds().length}`);
            // A repeated acknowledgement from the same socket must not create a
            // second presence event or replay the join sound for other clients.
            if (!repeatedJoin)
                socket.to(roomId).emit('peerJoined', { peerId, displayName: displayName.trim() });
            // Load persisted chat history so the joining peer (or someone who just
            // reloaded the page) sees prior messages. Empty when persistence is off.
            // Read markers of every participant so checkmarks render correctly on
            // already-sent messages right after joining/reloading.
            // Оба запроса некритичны для входа в звонок и выполняются параллельно с
            // ограничением по времени: висящая база больше не задерживает ack.
            const [messages, readMarkers] = await Promise.all([
                optional((0, db_1.getRoomMessages)(roomId), 5000, 'getRoomMessages', []),
                optional((0, db_1.getRoomReadMarkers)(roomId), 5000, 'getRoomReadMarkers', []),
            ]);
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
    // resetMediaState — rebuild transports without removing room presence
    // -----------------------------------------------------------------------
    socket.on('resetMediaState', (payload, callback) => {
        const roomId = (0, room_code_1.canonicalRoomCode)(payload?.roomId);
        const peerId = payload?.peerId;
        try {
            if (!roomId || typeof peerId !== 'string')
                return (0, helpers_1.err)(callback, 'Invalid media reset payload');
            if (session.roomId !== roomId || session.peerId !== peerId || (0, room_registry_1.getPeerSocket)(roomId, peerId) !== socket.id) {
                console.warn(`[media] Reset rejected room=${roomId} peer=${peerId} socket=${socket.id}`);
                return (0, helpers_1.err)(callback, 'Socket does not own this peer');
            }
            const room = room_registry_1.rooms.get(roomId);
            const peer = room?.getPeer(peerId);
            if (!room || !peer)
                return (0, helpers_1.err)(callback, 'Peer not found');
            const producerIds = [...peer.producers.keys()];
            const transportCount = peer.transports.size;
            const consumerCount = peer.consumers.size;
            peer.resetMedia();
            for (const producerId of producerIds) {
                socket.to(roomId).emit('producerClosed', { peerId, producerId });
            }
            console.log(`[media] State reset room=${roomId} peer=${peerId} socket=${socket.id} transports=${transportCount} producers=${producerIds.length} consumers=${consumerCount}`);
            (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            console.error(`[media] State reset failed room=${roomId} peer=${peerId} socket=${socket.id}`, e);
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
            const resolvedDirection = direction ?? 'send';
            const transportData = await room.createWebRtcTransport(peerId, resolvedDirection);
            console.log(`[media] Transport created room=${roomId} peer=${peerId} transport=${transportData.transportId} direction=${resolvedDirection} socket=${socket.id}`);
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
            console.log(`[media] ICE restart room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`);
            const iceParameters = await room.restartIce(peerId, transportId);
            (0, helpers_1.ack)(callback, iceParameters);
        }
        catch (e) {
            console.error(`[media] ICE restart failed room=${roomId} peer=${peerId} transport=${transportId} socket=${socket.id}`, e);
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
            console.log(`[media] Produced room=${roomId} peer=${peerId} producer=${result.producerId} kind=${kind} transport=${transportId} socket=${socket.id}`);
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
        const { roomId, peerId, transportId, producerId, rtpCapabilities } = payload;
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room)
                return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
            const consumerData = await room.consume(peerId, transportId, producerId, rtpCapabilities);
            console.log(`[media] Consumed room=${roomId} peer=${peerId} consumer=${consumerData.consumerId} producer=${producerId} kind=${consumerData.kind} transport=${transportId} socket=${socket.id}`);
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
    // pauseConsumer  (client-driven weak-downlink protection)
    //
    // The viewer's network guard decided that incoming video is drowning its
    // audio and asked us to stop forwarding it. Unlike a mute, this is a purely
    // local decision of ONE viewer — the producer keeps sending and everybody
    // else keeps receiving, so we deliberately do NOT broadcast anything here.
    // -----------------------------------------------------------------------
    socket.on('pauseConsumer', async (payload, callback) => {
        const { roomId, peerId, consumerId, paused } = payload ?? {};
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room) {
                if (callback)
                    return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
                return;
            }
            if (paused) {
                await room.pauseConsumer(peerId, consumerId);
            }
            else {
                await room.resumeConsumer(peerId, consumerId);
            }
            if (callback)
                (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            if (callback)
                (0, helpers_1.err)(callback, e.message);
        }
    });
    // -----------------------------------------------------------------------
    // setConsumerLayers  (client-driven weak-downlink protection, gentle step)
    //
    // The viewer's guard noticed its downlink is getting tight but not hopeless.
    // Rather than killing the picture we pin the consumer to the lowest simulcast
    // layer, which cuts the incoming video bitrate roughly 9× while keeping a
    // (small, choppy) image. Private to this viewer, so nothing is broadcast.
    // -----------------------------------------------------------------------
    socket.on('setConsumerLayers', async (payload, callback) => {
        const { roomId, peerId, consumerId, spatialLayer, temporalLayer } = payload ?? {};
        try {
            const room = room_registry_1.rooms.get(roomId);
            if (!room) {
                if (callback)
                    return (0, helpers_1.err)(callback, `Room ${roomId} not found`);
                return;
            }
            await room.setConsumerPreferredLayers(peerId, consumerId, spatialLayer, temporalLayer);
            if (callback)
                (0, helpers_1.ack)(callback, undefined);
        }
        catch (e) {
            if (callback)
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
