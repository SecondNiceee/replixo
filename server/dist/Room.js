"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Room = void 0;
const config_1 = require("./config");
class Room {
    constructor(id) {
        this.peers = new Map();
        // The presenter's current slide state. Null when no presentation is active.
        this.currentSlide = null;
        // Shared whiteboard (tldraw) state. `whiteboardOpen` is broadcast so the board
        // opens/closes for everyone at once. `whiteboardSnapshot` keeps the latest
        // full document snapshot in memory so a peer joining mid-session can load the
        // current drawing immediately (it is also persisted to the DB, debounced).
        this.whiteboardOpen = false;
        this.whiteboardSnapshot = null;
        // Presentation drawing annotations: рисунки поверх слайдов.
        // Map<slideIndex, snapshotDataURL> — один снапшот canvas на слайд.
        // Заполняется при создании комнаты из БД и обновляется по мере рисования.
        this.presentationDrawings = new Map();
        this.id = id;
    }
    // ---------------------------------------------------------------------------
    // Factory
    // ---------------------------------------------------------------------------
    static async create(id, worker) {
        const room = new Room(id);
        room.router = await worker.createRouter({ mediaCodecs: config_1.mediaCodecs });
        return room;
    }
    // ---------------------------------------------------------------------------
    // Peer management
    // ---------------------------------------------------------------------------
    hasPeer(peerId) {
        return this.peers.has(peerId);
    }
    isFull() {
        return this.peers.size >= config_1.MAX_PEERS_PER_ROOM;
    }
    isEmpty() {
        return this.peers.size === 0;
    }
    getPeer(peerId) {
        return this.peers.get(peerId);
    }
    addPeer(peer) {
        this.peers.set(peer.peerId, peer);
    }
    removePeer(peerId) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.close();
            this.peers.delete(peerId);
        }
    }
    /**
     * Returns the current state of all peers except the requesting one,
     * so a newly joined client can subscribe to existing streams.
     */
    getExistingPeersFor(requestingPeerId) {
        const result = [];
        for (const peer of this.peers.values()) {
            if (peer.peerId === requestingPeerId)
                continue;
            result.push({
                peerId: peer.peerId,
                displayName: peer.displayName,
                producers: [...peer.producers.values()].map((p) => ({
                    producerId: p.id,
                    kind: p.kind,
                    appData: p.appData,
                })),
            });
        }
        return result;
    }
    getPeerIds() {
        return [...this.peers.keys()];
    }
    // ---------------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------------
    async createWebRtcTransport(peerId, direction) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found in room ${this.id}`);
        // A media rebuild can happen while the peer remains in the room. Keep one
        // transport per direction so consumers can never attach to a stale recv
        // path left behind by a previous client transport.
        for (const existingTransport of [...peer.transports.values()]) {
            if (existingTransport.appData.direction !== direction)
                continue;
            peer.transports.delete(existingTransport.id);
            existingTransport.close();
        }
        const transport = await this.router.createWebRtcTransport({
            ...config_1.webRtcTransportOptions,
            appData: { direction },
        });
        // Raise the bandwidth-estimation ceiling so a high-bitrate screen share is
        // not artificially throttled. Without this the transport's estimated
        // outgoing bitrate can stay low and the shared screen degrades over time.
        try {
            await transport.setMaxIncomingBitrate(8000000);
        }
        catch {
            // Older mediasoup builds may not support it on every transport; ignore.
        }
        if (direction === 'recv') {
            try {
                await transport.setMaxOutgoingBitrate(8000000);
            }
            catch {
                // Optional API; ignore if unavailable.
            }
        }
        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed')
                transport.close();
        });
        // A closed transport MUST leave the peer's map. Otherwise a later
        // `restartIce` finds a JS object whose worker-side handler is already gone
        // and mediasoup throws "Channel request handler with ID ... not found".
        // The client then retries, exhausts its ICE ladder and rebuilds the whole
        // media session — which other participants perceive as the person leaving
        // and re-joining the room in a loop.
        transport.observer.once('close', () => {
            if (peer.transports.get(transport.id) === transport) {
                peer.transports.delete(transport.id);
            }
        });
        peer.addTransport(transport);
        return {
            transportId: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            iceServers: config_1.iceServers,
        };
    }
    async connectTransport(peerId, transportId, dtlsParameters) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const transport = peer.getTransport(transportId);
        if (!transport)
            throw new Error(`Transport ${transportId} not found`);
        await transport.connect({ dtlsParameters });
    }
    // ---------------------------------------------------------------------------
    // ICE Restart — re-negotiate ICE candidates after transient network drop /
    // VPN toggle without tearing down producers, consumers or the peer itself.
    // ---------------------------------------------------------------------------
    async restartIce(peerId, transportId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const transport = peer.getTransport(transportId);
        // A missing or already closed transport can never come back. Report it with
        // a stable marker so the client stops retrying ICE and rebuilds its media
        // session once, instead of looping restart → reject → rebuild → restart.
        if (!transport || transport.closed) {
            if (transport)
                peer.transports.delete(transportId);
            throw new Error('transport-gone');
        }
        // restartIce() generates fresh ICE credentials that the client uses to
        // kick-start a new connectivity check on the current DTLS session.
        try {
            return await transport.restartIce();
        }
        catch {
            // The worker-side transport is dead (router closed, channel handler gone).
            // Drop it so subsequent requests fail fast with the same marker.
            peer.transports.delete(transportId);
            try {
                transport.close();
            }
            catch {
                // already closed — ignore
            }
            throw new Error('transport-gone');
        }
    }
    // ---------------------------------------------------------------------------
    // Produce
    // ---------------------------------------------------------------------------
    async produce(peerId, transportId, kind, rtpParameters, appData = {}) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const transport = peer.getTransport(transportId);
        if (!transport)
            throw new Error(`Transport ${transportId} not found`);
        const producer = await transport.produce({ kind, rtpParameters, appData });
        producer.on('transportclose', () => {
            peer.producers.delete(producer.id);
        });
        peer.addProducer(producer);
        return { producerId: producer.id };
    }
    // ---------------------------------------------------------------------------
    // Consume
    // ---------------------------------------------------------------------------
    async consume(consumerPeerId, transportId, producerId, rtpCapabilities) {
        const consumerPeer = this.peers.get(consumerPeerId);
        if (!consumerPeer)
            throw new Error(`Consumer peer ${consumerPeerId} not found`);
        const recvTransport = consumerPeer.getTransport(transportId);
        if (!recvTransport || recvTransport.closed) {
            throw new Error(`Recv transport ${transportId} not found for peer ${consumerPeerId}`);
        }
        if (recvTransport.appData.direction !== 'recv') {
            throw new Error(`Transport ${transportId} is not a recv transport`);
        }
        if (!this.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error(`Router cannot consume producer ${producerId} with given rtpCapabilities`);
        }
        const consumer = await recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: true, // start paused, resume after client acks
        });
        consumer.on('transportclose', () => {
            consumerPeer.consumers.delete(consumer.id);
        });
        consumer.on('producerclose', () => {
            consumerPeer.consumers.delete(consumer.id);
        });
        consumerPeer.addConsumer(consumer);
        return {
            consumerId: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            producerPaused: consumer.producerPaused,
            appData: consumer.appData,
        };
    }
    closeProducer(peerId, producerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        const producer = peer.producers.get(producerId);
        if (producer) {
            producer.close();
            peer.producers.delete(producerId);
        }
    }
    async pauseProducer(peerId, producerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const producer = peer.producers.get(producerId);
        if (!producer)
            throw new Error(`Producer ${producerId} not found`);
        await producer.pause();
    }
    async resumeProducer(peerId, producerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const producer = peer.producers.get(producerId);
        if (!producer)
            throw new Error(`Producer ${producerId} not found`);
        await producer.resume();
    }
    /**
     * Pause a single consumer on the SFU side.
     *
     * Used by the client's weak-network guard: when a viewer's downlink can no
     * longer carry video without shredding the Opus stream, it asks us to stop
     * forwarding that video entirely. A client-only `consumer.pause()` would keep
     * the RTP flowing and free nothing, so the pause must be applied here.
     * Resuming goes through `resumeConsumer`, which also re-requests a keyframe.
     */
    async pauseConsumer(peerId, consumerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const consumer = peer.getConsumer(consumerId);
        if (!consumer)
            throw new Error(`Consumer ${consumerId} not found`);
        if (consumer.closed || consumer.paused)
            return;
        await consumer.pause();
    }
    async resumeConsumer(peerId, consumerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            throw new Error(`Peer ${peerId} not found`);
        const consumer = peer.getConsumer(consumerId);
        if (!consumer)
            throw new Error(`Consumer ${consumerId} not found`);
        await consumer.resume();
        // Force a fresh keyframe once a video consumer resumes. The consumer was
        // created paused, so the producer's earlier keyframe(s) were never forwarded
        // to this peer; without an explicit request the decoder can sit on
        // undecodable inter-frames and render a black frame until the next natural
        // keyframe (which is why toggling the sender's camera "fixes" it).
        //
        // A single request right after resume is unreliable: at that instant the
        // recv transport may have only just connected and the keyframe request (a
        // one-shot PLI/FIR) can be dropped before RTP is actually flowing, leaving
        // the newcomer on a permanent black frame. So we retry a few times with
        // increasing delays — the first request that lands after the path is live
        // makes the picture appear, and the extras are cheap no-ops.
        if (consumer.kind === 'video') {
            const requestKeyFrameSafely = () => {
                if (consumer.closed)
                    return;
                consumer.requestKeyFrame().catch(() => {
                    // Can reject if the consumer/producer closed meanwhile — ignore.
                });
            };
            requestKeyFrameSafely();
            for (const delay of [200, 600, 1200, 2500]) {
                setTimeout(requestKeyFrameSafely, delay);
            }
        }
    }
    /**
     * Highest spatial/temporal layer index the given producer actually publishes.
     *
     * The consumer's own `rtpParameters` are useless here — mediasoup gives a
     * simulcast consumer a single encoding regardless of how many layers the
     * sender produces — so the numbers have to come from the producer. Temporal
     * layers live in `scalabilityMode` ("L3T3" → 3 temporal layers); when it is
     * absent there is exactly one.
     */
    topLayersOf(producerId) {
        for (const peer of this.peers.values()) {
            const producer = peer.getProducer(producerId);
            if (!producer)
                continue;
            const encodings = producer.rtpParameters.encodings ?? [];
            const spatial = Math.max(1, encodings.length);
            const temporal = encodings.reduce((max, encoding) => {
                const match = /T(\d+)/.exec(encoding.scalabilityMode ?? '');
                return Math.max(max, match ? Number(match[1]) : 1);
            }, 1);
            return { spatialLayers: spatial - 1, temporalLayers: temporal - 1 };
        }
        // Producer went away mid-flight; a single-layer request is always safe.
        return { spatialLayers: 0, temporalLayers: 0 };
    }
    /**
     * Pin (or unpin) a consumer's simulcast layers.
     *
     * This is the step *before* pausing: instead of taking the picture away we
     * forward only the smallest layer the sender publishes (~100 kbps instead of
     * ~900 kbps), which is usually enough to stop starving the Opus stream. Only
     * meaningful for video; audio has a single layer.
     */
    async setConsumerPreferredLayers(peerId, consumerId, spatialLayer, temporalLayer) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        const consumer = peer.getConsumer(consumerId);
        if (!consumer || consumer.closed || consumer.kind !== 'video')
            return;
        try {
            if (spatialLayer === null) {
                // "Best available" — mediasoup has no explicit reset, so we ask for the
                // sender's top layer. It has to be derived from the *producer*, not
                // hard-coded: a literal 2 silently caps quality the moment someone
                // publishes more than three spatial layers (or CAMERA_ENCODINGS
                // changes), turning this "reset" into yet another restriction.
                const { spatialLayers, temporalLayers } = this.topLayersOf(consumer.producerId);
                await consumer.setPreferredLayers({
                    spatialLayer: spatialLayers,
                    temporalLayer: temporalLayers,
                });
                return;
            }
            await consumer.setPreferredLayers({
                spatialLayer,
                ...(typeof temporalLayer === 'number' ? { temporalLayer } : {}),
            });
        }
        catch {
            // Producer may be non-simulcast, or closed meanwhile — nothing to do.
        }
    }
    // ---------------------------------------------------------------------------
    // On-demand keyframe request.
    //
    // The fixed keyframe schedule in resumeConsumer() fires blind — it doesn't
    // know whether the frames actually reached the viewer. On slow / TURN-relayed
    // paths (common in the Electron desktop build) every one of those early
    // PLI/FIR requests can be sent before RTP is truly flowing, so they're
    // dropped and the newcomer is stuck on a permanent black frame while audio
    // works fine. The client watches its own decoded-frame stats and calls this
    // whenever the picture is still black, giving us a feedback loop: keep
    // pushing fresh keyframes until one lands on a live path and the image
    // appears. Cheap no-op once frames are flowing.
    // ---------------------------------------------------------------------------
    async requestConsumerKeyFrame(peerId, consumerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        const consumer = peer.getConsumer(consumerId);
        if (!consumer || consumer.closed || consumer.kind !== 'video')
            return;
        try {
            await consumer.requestKeyFrame();
        }
        catch {
            // consumer / producer may have closed meanwhile — ignore.
        }
    }
    // ---------------------------------------------------------------------------
    // Router capabilities
    // ---------------------------------------------------------------------------
    getRtpCapabilities() {
        return this.router.rtpCapabilities;
    }
    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------
    close() {
        for (const peer of this.peers.values()) {
            peer.close();
        }
        this.peers.clear();
        this.router.close();
    }
}
exports.Room = Room;
