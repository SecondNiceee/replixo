import type { Router, Worker, DtlsParameters } from 'mediasoup/node/lib/types'
import * as mediasoup from 'mediasoup'
import { mediaCodecs, webRtcTransportOptions, MAX_PEERS_PER_ROOM, iceServers } from './config'
import { Peer } from './Peer'
import type {
  TransportCreatedPayload,
  ProducedPayload,
  ConsumedPayload,
  ExistingPeerPayload,
} from './types'

export class Room {
  id: string
  private router!: Router
  private peers: Map<string, Peer> = new Map()

  private constructor(id: string) {
    this.id = id
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  static async create(id: string, worker: Worker): Promise<Room> {
    const room = new Room(id)
    room.router = await worker.createRouter({ mediaCodecs })
    return room
  }

  // ---------------------------------------------------------------------------
  // Peer management
  // ---------------------------------------------------------------------------

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId)
  }

  isFull(): boolean {
    return this.peers.size >= MAX_PEERS_PER_ROOM
  }

  isEmpty(): boolean {
    return this.peers.size === 0
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId)
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.peerId, peer)
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.close()
      this.peers.delete(peerId)
    }
  }

  /**
   * Returns the current state of all peers except the requesting one,
   * so a newly joined client can subscribe to existing streams.
   */
  getExistingPeersFor(requestingPeerId: string): ExistingPeerPayload[] {
    const result: ExistingPeerPayload[] = []
    for (const peer of this.peers.values()) {
      if (peer.peerId === requestingPeerId) continue
      result.push({
        peerId: peer.peerId,
        displayName: peer.displayName,
        producers: [...peer.producers.values()].map((p) => ({
          producerId: p.id,
          kind: p.kind,
          appData: p.appData as Record<string, unknown>,
        })),
      })
    }
    return result
  }

  getPeerIds(): string[] {
    return [...this.peers.keys()]
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  async createWebRtcTransport(peerId: string, direction: 'send' | 'recv'): Promise<TransportCreatedPayload> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found in room ${this.id}`)

    const transport = await this.router.createWebRtcTransport({
      ...webRtcTransportOptions,
      appData: { direction },
    })

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') transport.close()
    })

    peer.addTransport(transport)

    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers,
    }
  }

  async connectTransport(
    peerId: string,
    transportId: string,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const transport = peer.getTransport(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)

    await transport.connect({ dtlsParameters })
  }

  // ---------------------------------------------------------------------------
  // ICE Restart — re-negotiate ICE candidates after transient network drop /
  // VPN toggle without tearing down producers, consumers or the peer itself.
  // ---------------------------------------------------------------------------

  async restartIce(peerId: string, transportId: string): Promise<object> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const transport = peer.getTransport(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)

    // restartIce() generates fresh ICE credentials that the client uses to
    // kick-start a new connectivity check on the current DTLS session.
    const iceParameters = await transport.restartIce()
    return iceParameters
  }

  // ---------------------------------------------------------------------------
  // Produce
  // ---------------------------------------------------------------------------

  async produce(
    peerId: string,
    transportId: string,
    kind: 'audio' | 'video',
    rtpParameters: object,
    appData: Record<string, unknown> = {},
  ): Promise<ProducedPayload> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const transport = peer.getTransport(transportId)
    if (!transport) throw new Error(`Transport ${transportId} not found`)

    const producer = await transport.produce({ kind, rtpParameters, appData } as Parameters<typeof transport.produce>[0])

    producer.on('transportclose', () => {
      peer.producers.delete(producer.id)
    })

    peer.addProducer(producer)

    return { producerId: producer.id }
  }

  // ---------------------------------------------------------------------------
  // Consume
  // ---------------------------------------------------------------------------

  async consume(
    consumerPeerId: string,
    producerId: string,
    rtpCapabilities: object,
  ): Promise<ConsumedPayload> {
    const consumerPeer = this.peers.get(consumerPeerId)
    if (!consumerPeer) throw new Error(`Consumer peer ${consumerPeerId} not found`)

    // Find recv transport for this peer (marked by appData.direction)
    let recvTransport = null
    for (const transport of consumerPeer.transports.values()) {
      if ((transport.appData as Record<string, unknown>).direction === 'recv') {
        recvTransport = transport
        break
      }
    }
    if (!recvTransport) throw new Error(`No recv transport found for peer ${consumerPeerId}`)

    if (!this.router.canConsume({ producerId, rtpCapabilities } as Parameters<typeof this.router.canConsume>[0])) {
      throw new Error(`Router cannot consume producer ${producerId} with given rtpCapabilities`)
    }

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // start paused, resume after client acks
    } as Parameters<typeof recvTransport.consume>[0])

    consumer.on('transportclose', () => {
      consumerPeer.consumers.delete(consumer.id)
    })
    consumer.on('producerclose', () => {
      consumerPeer.consumers.delete(consumer.id)
    })

    consumerPeer.addConsumer(consumer)

    return {
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
      appData: consumer.appData as Record<string, unknown>,
    }
  }

  closeProducer(peerId: string, producerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    const producer = peer.producers.get(producerId)
    if (producer) {
      producer.close()
      peer.producers.delete(producerId)
    }
  }

  async pauseProducer(peerId: string, producerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)
    const producer = peer.producers.get(producerId)
    if (!producer) throw new Error(`Producer ${producerId} not found`)
    await producer.pause()
  }

  async resumeProducer(peerId: string, producerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)
    const producer = peer.producers.get(producerId)
    if (!producer) throw new Error(`Producer ${producerId} not found`)
    await producer.resume()
  }

  async resumeConsumer(peerId: string, consumerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const consumer = peer.getConsumer(consumerId)
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`)

    await consumer.resume()
  }

  // ---------------------------------------------------------------------------
  // Router capabilities
  // ---------------------------------------------------------------------------

  getRtpCapabilities(): object {
    return this.router.rtpCapabilities
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  close(): void {
    for (const peer of this.peers.values()) {
      peer.close()
    }
    this.peers.clear()
    this.router.close()
  }
}
