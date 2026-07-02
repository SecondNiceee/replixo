import { saveWhiteboard } from '../db'
import type {
  WhiteboardOpenPayload,
  WhiteboardChangePayload,
  WhiteboardSnapshotPayload,
} from '../types'
import { createRateLimiter, type HandlerContext } from './helpers'
import { authedRoom } from './room-registry'

// ---------------------------------------------------------------------------
// Shared whiteboard (tldraw)
//
// whiteboardOpen / whiteboardClose toggle a room-wide flag so the board
// appears/disappears for everyone at once. whiteboardChange relays a peer's
// incremental tldraw store diff to the others for live drawing.
// whiteboardSnapshot persists the full document (debounced by the client)
// and keeps an in-memory copy so mid-session joiners load the current state.
// ---------------------------------------------------------------------------

export function registerWhiteboardHandlers(ctx: HandlerContext): void {
  const { socket } = ctx

  socket.on('whiteboardOpen', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid } = payload as WhiteboardOpenPayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    room.whiteboardOpen = true
    void saveWhiteboard(rid, { open: true })
    // Others open the board too; hand them the current snapshot (may be null).
    socket.to(rid).emit('whiteboardOpened', { peerId: pid, snapshot: room.whiteboardSnapshot })
  })

  socket.on('whiteboardClose', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid } = payload as WhiteboardOpenPayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    room.whiteboardOpen = false
    void saveWhiteboard(rid, { open: false })
    socket.to(rid).emit('whiteboardClosed', { peerId: pid })
  })

  // Generous sliding-window limit: drawing fires many diffs per second, so
  // allow up to 240/sec before dropping to guard against a runaway client.
  const allowWhiteboardChange = createRateLimiter(240, 1000)

  socket.on('whiteboardChange', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid, changes } = payload as WhiteboardChangePayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    if (changes == null) return

    if (!allowWhiteboardChange()) return

    socket.to(rid).emit('whiteboardChange', { peerId: pid, changes })
  })

  socket.on('whiteboardSnapshot', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid, snapshot } = payload as WhiteboardSnapshotPayload
    const room = authedRoom(rid, pid, socket.id)
    if (!room) return
    // Cap snapshot size to avoid unbounded memory / DB rows from a bad client.
    if (typeof snapshot !== 'string' || snapshot.length > 5_000_000) return
    room.whiteboardSnapshot = snapshot
    void saveWhiteboard(rid, { snapshot })
  })
}
