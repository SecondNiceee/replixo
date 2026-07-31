import type { Router, Worker, DtlsParameters, WebRtcTransport } from 'mediasoup/node/lib/types'
import * as mediasoup from 'mediasoup'
import { mediaCodecs, webRtcTransportOptions, MAX_PEERS_PER_ROOM, iceServers } from './config'
import { Peer } from './Peer'
import type {
  TransportCreatedPayload,
  ProducedPayload,
  ConsumedPayload,
  ExistingPeerPayload,
  SlideState,
} from './types'

export class Room {
  id: string
  private router!: Router
  private peers: Map<string, Peer> = new Map()

  // The presenter's current slide state. Null when no presentation is active.
  currentSlide: SlideState | null = null

  // Shared whiteboard (tldraw) state. `whiteboardOpen` is broadcast so the board
  // opens/closes for everyone at once. `whiteboardSnapshot` keeps the latest
  // full document snapshot in memory so a peer joining mid-session can load the
  // current drawing immediately (it is also persisted to the DB, debounced).
  whiteboardOpen = false
  whiteboardSnapshot: string | null = null

  // Presentation drawing annotations: рисунки поверх слайдов.
  // Map<slideIndex, snapshotDataURL> — один снапшот canvas на слайд.
  // Заполняется при создании комнаты из БД и обновляется по мере рисования.
  presentationDrawings: Map<number, string> = new Map()

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

    // Raise the bandwidth-estimation ceiling so a high-bitrate screen share is
    // not artificially throttled. Without this the transport's estimated
    // outgoing bitrate can stay low and the shared screen degrades over time.
    try {
      await transport.setMaxIncomingBitrate(8_000_000)
    } catch {
      // Older mediasoup builds may not support it on every transport; ignore.
    }
    if (direction === 'recv') {
      try {
        await transport.setMaxOutgoingBitrate(8_000_000)
      } catch {
        // Optional API; ignore if unavailable.
      }
    }

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') transport.close()
    })

    // A closed transport MUST leave the peer's map. Otherwise a later
    // `restartIce` finds a JS object whose worker-side handler is already gone
    // and mediasoup throws "Channel request handler with ID ... not found".
    // The client then retries, exhausts its ICE ladder and rebuilds the whole
    // media session — which other participants perceive as the person leaving
    // and re-joining the room in a loop.
    transport.observer.once('close', () => {
      if (peer.transports.get(transport.id) === transport) {
        peer.transports.delete(transport.id)
      }
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
    // A missing or already closed transport can never come back. Report it with
    // a stable marker so the client stops retrying ICE and rebuilds its media
    // session once, instead of looping restart → reject → rebuild → restart.
    if (!transport || transport.closed) {
      if (transport) peer.transports.delete(transportId)
      throw new Error('transport-gone')
    }

    // restartIce() generates fresh ICE credentials that the client uses to
    // kick-start a new connectivity check on the current DTLS session.
    try {
      return await transport.restartIce()
    } catch {
      // The worker-side transport is dead (router closed, channel handler gone).
      // Drop it so subsequent requests fail fast with the same marker.
      peer.transports.delete(transportId)
      try {
        transport.close()
      } catch {
        // already closed — ignore
      }
      throw new Error('transport-gone')
    }
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
    let recvTransport: WebRtcTransport | null = null
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

  /**
   * Pause a single consumer on the SFU side.
   *
   * Used by the client's weak-network guard: when a viewer's downlink can no
   * longer carry video without shredding the Opus stream, it asks us to stop
   * forwarding that video entirely. A client-only `consumer.pause()` would keep
   * the RTP flowing and free nothing, so the pause must be applied here.
   * Resuming goes through `resumeConsumer`, which also re-requests a keyframe.
   */
  async pauseConsumer(peerId: string, consumerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const consumer = peer.getConsumer(consumerId)
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`)
    if (consumer.closed || consumer.paused) return

    await consumer.pause()
  }

  async resumeConsumer(peerId: string, consumerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`Peer ${peerId} not found`)

    const consumer = peer.getConsumer(consumerId)
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`)

    await consumer.resume()

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
        if (consumer.closed) return
        consumer.requestKeyFrame().catch(() => {
          // Can reject if the consumer/producer closed meanwhile — ignore.
        })
      }
      requestKeyFrameSafely()
      for (const delay of [200, 600, 1200, 2500]) {
        setTimeout(requestKeyFrameSafely, delay)
      }
    }
  }

  /**
   * Pin (or unpin) a consumer's simulcast layers.
   *
   * This is the step *before* pausing: instead of taking the picture away we
   * forward only the smallest layer the sender publishes (~100 kbps instead of
   * ~900 kbps), which is usually enough to stop starving the Opus stream. Only
   * meaningful for video; audio has a single layer.
   */
  async setConsumerPreferredLayers(
    peerId: string,
    consumerId: string,
    spatialLayer: number | null,
    temporalLayer?: number | null,
  ): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) return
    const consumer = peer.getConsumer(consumerId)
    if (!consumer || consumer.closed || consumer.kind !== 'video') return

    try {
      if (spatialLayer === null) {
        // "Best available" — mediasoup has no explicit reset, so ask for a layer
        // index above anything a sender can publish and let it clamp down.
        await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 })
        return
      }
      await consumer.setPreferredLayers({
        spatialLayer,
        ...(typeof temporalLayer === 'number' ? { temporalLayer } : {}),
      })
    } catch {
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
  async requestConsumerKeyFrame(peerId: string, consumerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) return
    const consumer = peer.getConsumer(consumerId)
    if (!consumer || consumer.closed || consumer.kind !== 'video') return
    try {
      await consumer.requestKeyFrame()
    } catch {
      // consumer / producer may have closed meanwhile — ignore.
    }
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
