import type { Worker } from 'mediasoup/types'
import type { Server } from 'socket.io'
import { Room } from '../Room'
import { deleteRoomMessages, getWhiteboard, getPresentationDrawings } from '../db'
import { deleteRoomUploads } from '../uploads'

// ---------------------------------------------------------------------------
// In-memory room store shared by all handler modules
// ---------------------------------------------------------------------------

export const rooms = new Map<string, Room>()

// roomId + peerId → socketId. A peer identifier is scoped to one room so a
// delayed disconnect (or the same browser session in another room) cannot
// evict an unrelated active participant.
export const peerSockets = new Map<string, string>()

export function roomPeerKey(roomId: string, peerId: string): string {
  return `${roomId}\u0000${peerId}`
}

export function getPeerSocket(roomId: string, peerId: string): string | undefined {
  return peerSockets.get(roomPeerKey(roomId, peerId))
}

export function setPeerSocket(roomId: string, peerId: string, socketId: string): void {
  peerSockets.set(roomPeerKey(roomId, peerId), socketId)
}

// roomId + peerId → clientId: a nonce generated once per page load. Because the
// peerId is stable per browser profile + room, a reconnect from the SAME page
// arrives with the same peerId but a new socket id — indistinguishable from a
// genuine second tab unless we also compare the page instance. Without it a
// client recovering from a Wi-Fi/VPN hand-off can kick itself out of the room.
const peerClients = new Map<string, string>()

export function getPeerClient(roomId: string, peerId: string): string | undefined {
  return peerClients.get(roomPeerKey(roomId, peerId))
}

export function setPeerClient(roomId: string, peerId: string, clientId: string | undefined): void {
  const key = roomPeerKey(roomId, peerId)
  if (clientId) peerClients.set(key, clientId)
  else peerClients.delete(key)
}

// roomId + peerId → pending-removal timer. When a socket drops (phone locks/backgrounds,
// Wi-Fi hand-off, tunnel switch) we DON'T evict the peer immediately. Instead we
// keep its producers/consumers/transports alive for a grace window so that when
// the device comes back it resumes via rejoinProbe + ICE restart and never
// "disappears" for the other participants. Only if it stays gone past the
// window do we actually remove it.
const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>()

// How long a peer may stay silently disconnected before we evict it. Mobile
// backgrounding / screen-lock can suspend the socket for a while, so we allow a
// generous window. 45 s comfortably covers a user briefly checking another app.
export const DISCONNECT_GRACE_MS = 45000

// Much shorter window used when the client explicitly told us it is going away
// (tab/browser closed or navigated away — signalled via a sendBeacon on
// `pagehide`/`beforeunload`). We don't evict *instantly* so that a page reload
// or an accidental quick return can still cancel the eviction via
// rejoinProbe/joinRoom, but 6 s means other participants see the person leave
// almost right away instead of waiting out the full grace window.
export const CLOSE_GRACE_MS = 6000

// Fallback window for a *clean* socket close that arrived WITHOUT a beacon.
// When a tab/browser is closed, the WebSocket is closed gracefully and Socket.io
// reports the disconnect reason as "transport close" / "client namespace
// disconnect" — this fires immediately, with no ping-timeout latency. The beacon
// is unreliable (it can be dropped on abrupt tab kills, some mobile browsers,
// blocked requests, Electron, etc.), so we must NOT depend on it: a clean close
// is itself strong evidence the user is gone. We still allow a small window so a
// page reload or a mobile WiFi↔4G hand-off (which can also surface as a clean
// close) has time to reconnect via rejoinProbe before we evict.
export const CLEAN_CLOSE_GRACE_MS = 10000

// peerIds that announced an intentional close. When such a peer's socket also
// drops we use CLOSE_GRACE_MS instead of DISCONNECT_GRACE_MS.
const closingPeers = new Set<string>()

export function markClosing(roomId: string, peerId: string): void {
  closingPeers.add(roomPeerKey(roomId, peerId))
}

export function isClosing(roomId: string, peerId: string): boolean {
  return closingPeers.has(roomPeerKey(roomId, peerId))
}

export function clearPendingDisconnect(roomId: string, peerId: string): void {
  const key = roomPeerKey(roomId, peerId)
  const t = pendingDisconnects.get(key)
  if (t) {
    clearTimeout(t)
    pendingDisconnects.delete(key)
  }
  // A (re)join or explicit leave voids any pending "closing" intent too.
  closingPeers.delete(key)
}

// Replace any pending eviction timer WITHOUT clearing the "closing" flag, so
// the disconnect and beacon paths can race in any order without stomping each
// other's intent.
export function scheduleEviction(roomId: string, peerId: string, timer: ReturnType<typeof setTimeout>): void {
  const key = roomPeerKey(roomId, peerId)
  const existing = pendingDisconnects.get(key)
  if (existing) clearTimeout(existing)
  pendingDisconnects.set(key, timer)
}

export function deletePendingDisconnect(roomId: string, peerId: string): void {
  pendingDisconnects.delete(roomPeerKey(roomId, peerId))
}

/**
 * Remove a peer from its room and notify everyone. Safe to call without a
 * socket context (e.g. from a grace-window timer or the sendBeacon HTTP
 * endpoint). Idempotent: a no-op if the peer is no longer in the room.
 */
export function evictPeer(io: Server, roomId: string, peerId: string, expectedSocketId?: string): void {
  if (expectedSocketId && getPeerSocket(roomId, peerId) !== expectedSocketId) return
  clearPendingDisconnect(roomId, peerId)

  const room = rooms.get(roomId)
  if (!room || !room.hasPeer(peerId)) return

  // If the leaving peer was the presenter, clear slide state and notify.
  if (room.currentSlide?.peerId === peerId) {
    room.currentSlide = null
    io.to(roomId).emit('presentationEnded', { peerId })
  }

  room.removePeer(peerId)
  io.to(roomId).emit('peerLeft', { peerId })
  peerSockets.delete(roomPeerKey(roomId, peerId))
  peerClients.delete(roomPeerKey(roomId, peerId))

  console.log(`[room] Peer ${peerId} evicted from room ${roomId}`)
  cleanupRoomIfEmpty(roomId)
}

export function getOrCreateRoom(roomId: string, worker: Worker): Promise<Room> {
  if (rooms.has(roomId)) return Promise.resolve(rooms.get(roomId)!)
  return Room.create(roomId, worker).then(async (room) => {
    rooms.set(roomId, room)
    console.log(`[room] Created room ${roomId}`)
    // Hydrate any persisted whiteboard state so a board drawn in a previous
    // session (e.g. before a server restart) is restored. No-op without DB.
    try {
      const wb = await getWhiteboard(roomId)
      room.whiteboardOpen = wb.open
      room.whiteboardSnapshot = wb.snapshot
    } catch {
      // Ignore — board simply starts empty.
    }
    // Hydrate presentation drawing annotations (рисунки поверх слайдов).
    try {
      const drawings = await getPresentationDrawings(roomId)
      room.presentationDrawings = drawings
    } catch {
      // Ignore — slides start empty.
    }
    return room
  })
}

export function cleanupRoomIfEmpty(roomId: string): void {
  const room = rooms.get(roomId)
  if (room && room.isEmpty()) {
    room.close()
    rooms.delete(roomId)
    console.log(`[room] Removed empty room ${roomId}`)
    // Комната уничтожена — стираем всю историю её чата и файловые вложения с
    // диска. Fire-and-forget: удаление не должно блокировать поток сокета.
    void deleteRoomMessages(roomId)
    void deleteRoomUploads(roomId)
  }
}

/**
 * Validate an incoming (roomId, peerId) pair against the sender's socket:
 * the room must exist, the peer must be in it, and the peerId must belong to
 * this exact socket. Returns the room on success, null otherwise.
 */
export function authedRoom(rid: unknown, pid: unknown, socketId: string): Room | null {
  if (typeof rid !== 'string' || !rid) return null
  if (typeof pid !== 'string' || !pid) return null
  const room = rooms.get(rid)
  if (!room || !room.hasPeer(pid)) return null
  if (getPeerSocket(rid, pid) !== socketId) return null
  return room
}
