import type { RemotePeer, RoomStatus, ChatMessage, MediaSource } from "./types"
import { streamKeyFor, normalizeSource } from "./types"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  status: RoomStatus
  error: string | null
  peers: Map<string, RemotePeer>
  localStream: MediaStream | null
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  hasMic: boolean
  hasCam: boolean
  messages: ChatMessage[]
  readMarkers: Record<string, number>
  whiteboardOpen: boolean
  whiteboardSnapshot: string | null
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: "CONNECTING" }
  | { type: "CONNECTED"; localStream: MediaStream }
  | { type: "DISCONNECTED" }
  | { type: "ERROR"; error: string }
  | { type: "PEER_JOINED"; peerId: string; displayName: string }
  | { type: "PEER_STREAM"; peerId: string; displayName: string; kind: "video" | "audio"; source: MediaSource; stream: MediaStream }
  | { type: "PEER_LEFT"; peerId: string }
  | { type: "PEER_PRODUCER_CLOSED"; peerId: string; source: MediaSource; kind: "video" | "audio" }
  | { type: "PEER_AUDIO_MUTED"; peerId: string; muted: boolean }
  | { type: "PEER_VIDEO_PAUSED"; peerId: string; paused: boolean }
  | { type: "TOGGLE_MIC"; isMuted: boolean; hasMic?: boolean }
  | { type: "TOGGLE_CAM"; isOff: boolean; hasCam?: boolean }
  | { type: "SET_SCREEN_SHARING"; isSharing: boolean }
  | { type: "ADD_MESSAGE"; message: ChatMessage }
  | { type: "SET_READ_MARKER"; peerId: string; ts: number }
  | { type: "SET_WHITEBOARD"; open: boolean; snapshot?: string | null }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "CONNECTING":
      return { ...state, status: "connecting", error: null }

    case "CONNECTED":
      return { ...state, status: "connected", localStream: action.localStream }

    case "DISCONNECTED":
      return { ...state, status: "disconnected", localStream: null, peers: new Map(), hasMic: false, hasCam: false }

    case "ERROR":
      return { ...state, status: "error", error: action.error }

    case "PEER_JOINED": {
      const peers = new Map(state.peers)
      if (!peers.has(action.peerId)) {
        peers.set(action.peerId, { peerId: action.peerId, displayName: action.displayName })
      }
      return { ...state, peers }
    }

    case "PEER_STREAM": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId) ?? { peerId: action.peerId, displayName: action.displayName }
      const key = streamKeyFor(action.source, action.kind)
      peers.set(action.peerId, { ...existing, [key]: action.stream })
      return { ...state, peers }
    }

    case "PEER_LEFT": {
      const peers = new Map(state.peers)
      peers.delete(action.peerId)
      return { ...state, peers }
    }

    case "PEER_AUDIO_MUTED": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId)
      if (!existing) return state
      if (existing.audioMuted === action.muted) return state
      peers.set(action.peerId, { ...existing, audioMuted: action.muted })
      return { ...state, peers }
    }

    case "PEER_VIDEO_PAUSED": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId)
      if (!existing) return state
      if (existing.videoPaused === action.paused) return state
      peers.set(action.peerId, { ...existing, videoPaused: action.paused })
      return { ...state, peers }
    }

    case "PEER_PRODUCER_CLOSED": {
      const peers = new Map(state.peers)
      const existing = peers.get(action.peerId)
      if (!existing) return state
      const key = streamKeyFor(action.source, action.kind)
      const updated = { ...existing }
      delete updated[key as keyof RemotePeer]
      if (action.source === "media" && action.kind === "audio") updated.audioMuted = false
      // A closed camera producer supersedes "paused": leaving the flag set would
      // keep showing "video paused" after the sender actually turned the camera
      // off, and would stick to the next producer they open.
      if (action.source === "media" && action.kind === "video") updated.videoPaused = false
      peers.set(action.peerId, updated)
      return { ...state, peers }
    }

    case "TOGGLE_MIC":
      return { ...state, isMicMuted: action.isMuted, hasMic: action.hasMic ?? state.hasMic }

    case "TOGGLE_CAM":
      return { ...state, isCamOff: action.isOff, hasCam: action.hasCam ?? state.hasCam }

    case "SET_SCREEN_SHARING":
      return { ...state, isScreenSharing: action.isSharing }

    case "ADD_MESSAGE": {
      if (state.messages.some((m) => m.id === action.message.id)) return state
      const next = [...state.messages, action.message]
      return { ...state, messages: next.length > 500 ? next.slice(next.length - 500) : next }
    }

    case "SET_READ_MARKER": {
      const prev = state.readMarkers[action.peerId] ?? 0
      if (action.ts <= prev) return state
      return { ...state, readMarkers: { ...state.readMarkers, [action.peerId]: action.ts } }
    }

    case "SET_WHITEBOARD":
      return {
        ...state,
        whiteboardOpen: action.open,
        whiteboardSnapshot: action.snapshot !== undefined ? action.snapshot : state.whiteboardSnapshot,
      }

    default:
      return state
  }
}

// Re-export normalizeSource so callers don't need to import from two places
export { normalizeSource }
