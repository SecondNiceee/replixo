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

// Client → server: a peer reports it has read the chat up to `ts` (ms).
export interface ChatReadPayload {
  roomId: string
  peerId: string
  ts: number
}

// Server → client (broadcast): a peer's read marker advanced to `ts` (ms).
export interface ChatReadBroadcastPayload {
  peerId: string
  ts: number
}

// ---------------------------------------------------------------------------
// Shared whiteboard (tldraw)
// ---------------------------------------------------------------------------

// Client → server: open / close the shared board for the whole room.
export interface WhiteboardOpenPayload {
  roomId: string
  peerId: string
}

// Client → server: incremental tldraw store changes to relay to other peers.
// `changes` is an opaque serialized diff (added/updated records + removed ids).
export interface WhiteboardChangePayload {
  roomId: string
  peerId: string
  changes: unknown
}

// Client → server: a full tldraw snapshot to persist (debounced by the client).
export interface WhiteboardSnapshotPayload {
  roomId: string
  peerId: string
  snapshot: string
}

// ---------------------------------------------------------------------------
// Presentation drawing annotations (canvas рисунки поверх слайдов)
// ---------------------------------------------------------------------------

// Client → server: diff одного мазка (сегмент линии или точка).
// Данные непрозрачны для сервера — он просто транслирует их всем остальным.
export interface PresentationStrokePayload {
  roomId: string
  peerId: string
  slideIndex: number
  // Сериализованный мазок: { tool, color, lineWidth, points: [{x,y},...] }
  stroke: unknown
}

// Client → server: стереть рисунок на конкретном слайде.
export interface PresentationDrawClearPayload {
  roomId: string
  peerId: string
  slideIndex: number
}

// Client → server: полный снапшот canvas слайда (data URL, debounced).
export interface PresentationDrawSnapshotPayload {
  roomId: string
  peerId: string
  slideIndex: number
  snapshot: string // data:image/png;base64,...
}

// ---------------------------------------------------------------------------
// Screen-share annotations (рисование поверх демонстрации экрана)
//
// Эфемерные аннотации, привязанные к активной демонстрации экрана. Любой
// участник может рисовать поверх стрима, и все остальные (включая того, кто
// демонстрирует) это видят. Данные непрозрачны для сервера — он просто
// транслирует их остальным. Координаты нормализованы (0..1) на стороне клиента.
// ---------------------------------------------------------------------------

// Client → server: один штрих (vector-мазок) поверх стрима.
export interface AnnotationStrokePayload {
  roomId: string
  peerId: string
  // Сериализованный штрих: { id, tool, color, lineWidth, points: [{x,y},...] }
  stroke: unknown
}

// Client → server: стереть все аннотации поверх стрима.
export interface AnnotationClearPayload {
  roomId: string
  peerId: string
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
