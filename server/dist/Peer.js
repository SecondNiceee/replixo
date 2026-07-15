"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Peer = void 0;
class Peer {
    constructor({ peerId, displayName, socketId }) {
        this.peerId = peerId;
        this.displayName = displayName;
        this.socketId = socketId;
        this.transports = new Map();
        this.producers = new Map();
        this.consumers = new Map();
    }
    addTransport(transport) {
        this.transports.set(transport.id, transport);
    }
    getTransport(transportId) {
        return this.transports.get(transportId);
    }
    addProducer(producer) {
        this.producers.set(producer.id, producer);
    }
    getProducer(producerId) {
        return this.producers.get(producerId);
    }
    addConsumer(consumer) {
        this.consumers.set(consumer.id, consumer);
    }
    getConsumer(consumerId) {
        return this.consumers.get(consumerId);
    }
    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------
    close() {
        for (const transport of this.transports.values()) {
            transport.close();
        }
        this.transports.clear();
        this.producers.clear();
        this.consumers.clear();
    }
}
exports.Peer = Peer;
