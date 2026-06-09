import type { Consumer, Producer, WebRtcTransport } from 'mediasoup/node/lib/types'
import type { PeerData } from './types'

export class Peer implements PeerData {
  peerId: string
  displayName: string
  socketId: string
  transports: Map<string, WebRtcTransport>
  producers: Map<string, Producer>
  consumers: Map<string, Consumer>
  rtpCapabilities?: object

  constructor({ peerId, displayName, socketId }: { peerId: string; displayName: string; socketId: string }) {
    this.peerId = peerId
    this.displayName = displayName
    this.socketId = socketId
    this.transports = new Map()
    this.producers = new Map()
    this.consumers = new Map()
  }

  addTransport(transport: WebRtcTransport): void {
    this.transports.set(transport.id, transport)
  }

  getTransport(transportId: string): WebRtcTransport | undefined {
    return this.transports.get(transportId)
  }

  addProducer(producer: Producer): void {
    this.producers.set(producer.id, producer)
  }

  getProducer(producerId: string): Producer | undefined {
    return this.producers.get(producerId)
  }

  addConsumer(consumer: Consumer): void {
    this.consumers.set(consumer.id, consumer)
  }

  getConsumer(consumerId: string): Consumer | undefined {
    return this.consumers.get(consumerId)
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  close(): void {
    for (const transport of this.transports.values()) {
      transport.close()
    }
    this.transports.clear()
    this.producers.clear()
    this.consumers.clear()
  }
}
