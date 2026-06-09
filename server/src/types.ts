import type {
  Consumer,
  DtlsParameters,
  Producer,
  WebRtcTransport,
} from 'mediasoup/node/lib/types'

// ---------------------------------------------------------------------------
// Socket event payloads  (client → server)
// ---------------------------------------------------------------------------

export interface JoinRoomPayload {
  roomId: string
  peerId: string
  displayName: string
  rtpCapabilities: object
  create?: boolean
}

export interface CreateTransportPayload {
  roomId: string
  peerId: string
  direction: 'send' | 'recv'
}

export interface ConnectTransportPayload {
  roomId: string
  peerId: string
  transportId: string
  dtlsParameters: DtlsParameters
}

export interface ProducePayload {
  roomId: string
  peerId: string
  transportId: string
  kind: 'audio' | 'video'
  rtpParameters: object
  appData?: Record<string, unknown>
}

export interface ConsumePayload {
  roomId: string
  peerId: string
  producerId: string
  rtpCapabilities: object
}

export interface ResumeConsumerPayload {
  roomId: string
  peerId: string
  consumerId: string
}

export interface CloseProducerPayload {
  roomId: string
  peerId: string
  producerId: string
}

export interface PauseProducerPayload {
  roomId: string
  peerId: string
  producerId: string
  paused: boolean
}

// ---------------------------------------------------------------------------
// Socket event payloads  (server → client)
// ---------------------------------------------------------------------------

export interface TransportCreatedPayload {
  transportId: string
  iceParameters: object
  iceCandidates: object[]
  dtlsParameters: object
  iceServers: object[]
}

export interface ProducedPayload {
  producerId: string
}

export interface ConsumedPayload {
  consumerId: string
  producerId: string
  kind: string
  rtpParameters: object
  producerPaused: boolean
  appData: Record<string, unknown>
}

export interface ExistingPeerPayload {
  peerId: string
  displayName: string
  producers: { producerId: string; kind: string; appData: Record<string, unknown> }[]
}

export interface NewProducerPayload {
  peerId: string
  displayName: string
  producerId: string
  kind: string
  appData: Record<string, unknown>
}

export interface PeerLeftPayload {
  peerId: string
}

export interface ProducerClosedPayload {
  peerId: string
  producerId: string
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface PeerTransports {
  send?: WebRtcTransport
  recv?: WebRtcTransport
}

export interface PeerData {
  peerId: string
  displayName: string
  socketId: string
  transports: Map<string, WebRtcTransport>
  producers: Map<string, Producer>
  consumers: Map<string, Consumer>
  rtpCapabilities?: object
}
