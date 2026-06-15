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

// ---------------------------------------------------------------------------
// Presentation / slide sync
// ---------------------------------------------------------------------------

// Shared slide state stored on the Room and sent to joining peers.
export interface SlideState {
  peerId: string
  slide: number  // 0-based index
  total: number  // total slides/pages
}

// Client → server
export interface PresentationSlidePayload {
  roomId: string
  peerId: string
  slide: number   // 0-based index
  total: number   // total number of slides/pages
}

// Server → client (broadcast)
export interface PresentationSlideChangedPayload {
  peerId: string
  slide: number
  total: number
}

export interface PresentationEndedPayload {
  peerId: string
}

export interface ProducerClosedPayload {
  peerId: string
  producerId: string
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// Client → server: a peer sends a chat message.
// `id` is an optional client-generated id reused for persistence + broadcast so
// the sender's optimistic copy matches the stored record (prevents duplicates).
export interface ChatMessagePayload {
  roomId: string
  peerId: string
  text: string
  id?: string
}

// Server → client (broadcast): a chat message with server-assigned id/timestamp.
export interface ChatMessageBroadcastPayload {
  id: string
  peerId: string
  displayName: string
  text: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Whiteboard (collaborative drawing)
// ---------------------------------------------------------------------------
//
// A shared canvas everyone can draw on. We sync the strokes (not a video
// stream): each drawn segment is broadcast as normalized coordinates so it
// scales to every participant's screen. The Room keeps the full stroke list in
// memory so latecomers can replay it; it dies with the room (no persistence).

export type WhiteboardMode = 'pen' | 'eraser'

// A single freehand stroke. `points` is a flat list [x0,y0,x1,y1,...] of
// normalized coordinates in the 0..1 range (relative to a fixed 16:9 surface).
export interface WhiteboardStroke {
  id: string
  color: string
  width: number
  mode: WhiteboardMode
  points: number[]
}

// Client → server: a batch of new points for one stroke (live drawing).
export interface WhiteboardPointsPayload {
  roomId: string
  peerId: string
  id: string
  color: string
  width: number
  mode: WhiteboardMode
  points: number[]
}

// Snapshot sent to a joining peer.
export interface WhiteboardState {
  active: boolean
  strokes: WhiteboardStroke[]
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
