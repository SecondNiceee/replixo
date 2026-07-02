import { ack, err, type Callback, type HandlerContext } from './helpers'
import {
  rooms,
  peerSockets,
  clearPendingDisconnect,
  setPendingDisconnect,
  deletePendingDisconnect,
  cleanupRoomIfEmpty,
  DISCONNECT_GRACE_MS,
} from './room-registry'

// ---------------------------------------------------------------------------
// Connection lifecycle: rejoinProbe, leaveRoom, disconnect (+ grace window)
// ---------------------------------------------------------------------------

export function registerLifecycleHandlers(ctx: HandlerContext): void {
  const { io, socket, session } = ctx

  // -----------------------------------------------------------------------
  // Internal helper — remove a peer from its room and notify everyone.
  // -----------------------------------------------------------------------
  function handleLeave(roomId: string, peerId: string): void {
    // An explicit leave (or grace-window expiry) supersedes any pending timer.
    clearPendingDisconnect(peerId)

    const room = rooms.get(roomId)
    if (!room) return

    // If the leaving peer was the presenter, clear the slide state and notify.
    // Use io.to() instead of socket.to() — handleLeave may be called from a
    // grace-window setTimeout after the socket has already disconnected and
    // left the room, in which case socket.to() would be a no-op.
    if (room.currentSlide?.peerId === peerId) {
      room.currentSlide = null
      io.to(roomId).emit('presentationEnded', { peerId })
    }

    room.removePeer(peerId)
    io.to(roomId).emit('peerLeft', { peerId })
    socket.leave(roomId)

    // Only clear the global peerSockets entry if this socket is still the
    // authoritative one for that peerId (it won't be if a new tab already
    // took over via the kick-duplicate logic above).
    if (peerSockets.get(peerId) === socket.id) {
      peerSockets.delete(peerId)
    }

    console.log(`[room] Peer ${peerId} left room ${roomId}`)
    cleanupRoomIfEmpty(roomId)

    session.roomId = null
    session.peerId = null
  }

  // -----------------------------------------------------------------------
  // rejoinProbe — client checks whether the server still has the peer after
  // a socket.io reconnect. Returns null if the peer is still in the room,
  // or an error string if it was evicted (so the client can do a full rejoin).
  // -----------------------------------------------------------------------
  socket.on(
    'rejoinProbe',
    ({ roomId, peerId }: { roomId: string; peerId: string }, callback: Callback<void>) => {
      const room = rooms.get(roomId)
      if (!room || !room.hasPeer(peerId)) {
        return err(callback as Callback<never>, 'peer evicted')
      }
      // The peer is back on a fresh socket within the grace window — cancel the
      // pending eviction and re-bind it to this socket so media keeps flowing.
      clearPendingDisconnect(peerId)
      // Re-join the socket.io room: after a reconnect this is a brand-new
      // socket, so without this it would miss peerJoined/newProducer/etc.
      socket.join(roomId)
      session.roomId = roomId
      session.peerId = peerId
      // Update the socket mapping in case the socket.id changed on reconnect.
      peerSockets.set(peerId, socket.id)
      ack(callback, undefined)
    },
  )

  // -----------------------------------------------------------------------
  // leaveRoom  (explicit)
  // -----------------------------------------------------------------------
  socket.on('leaveRoom', ({ roomId, peerId }: { roomId: string; peerId: string }) => {
    handleLeave(roomId, peerId)
  })

  // -----------------------------------------------------------------------
  // disconnect  (implicit) — DO NOT evict immediately.
  //
  // A dropped socket usually means the phone locked/backgrounded or the
  // network hiccupped, not that the user left. Removing the peer right away is
  // exactly what made people "disappear and never come back". Instead we keep
  // the peer (and all its producers/consumers) alive for a grace window. If
  // the same peer reconnects (rejoinProbe / joinRoom) within that window we
  // cancel the eviction and media resumes seamlessly. Only if it never comes
  // back do we finally remove it.
  // -----------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`[socket] Client disconnected: ${socket.id}`)
    if (!session.roomId || !session.peerId) return

    const roomId = session.roomId
    const peerId = session.peerId

    // If a newer socket already took over this peerId (duplicate-tab kick or a
    // fast reconnect), this stale socket must not touch the peer at all.
    if (peerSockets.get(peerId) !== socket.id) return

    clearPendingDisconnect(peerId)
    const timer = setTimeout(() => {
      deletePendingDisconnect(peerId)
      // Re-check: the peer may have reconnected on a new socket meanwhile.
      if (peerSockets.get(peerId) !== socket.id) return
      console.log(`[room] Peer ${peerId} did not return within grace window — evicting`)
      handleLeave(roomId, peerId)
    }, DISCONNECT_GRACE_MS)
    setPendingDisconnect(peerId, timer)
  })
}
