import type { Worker } from 'mediasoup/node/lib/types'
import { Room } from '../Room'
import { deleteRoomMessages, getWhiteboard, getPresentationDrawings } from '../db'
import { deleteRoomUploads } from '../uploads'

// ---------------------------------------------------------------------------
// In-memory room store shared by all handler modules
// ---------------------------------------------------------------------------

export const rooms = new Map<string, Room>()

// peerId → socketId — tracks where each peer is currently connected so we can
// kick an old tab when the same peer reconnects from a new one.
export const peerSockets = new Map<string, string>()

// peerId → pending-removal timer. When a socket drops (phone locks/backgrounds,
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

export function clearPendingDisconnect(peerId: string): void {
  const t = pendingDisconnects.get(peerId)
  if (t) {
    clearTimeout(t)
    pendingDisconnects.delete(peerId)
  }
}

export function setPendingDisconnect(peerId: string, timer: ReturnType<typeof setTimeout>): void {
  pendingDisconnects.set(peerId, timer)
}

export function deletePendingDisconnect(peerId: string): void {
  pendingDisconnects.delete(peerId)
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
  if (peerSockets.get(pid) !== socketId) return null
  return room
}
