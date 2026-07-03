import { ack, err, type Callback, type HandlerContext } from './helpers'
import {
  rooms,
  peerSockets,
  clearPendingDisconnect,
  scheduleEviction,
  deletePendingDisconnect,
  evictPeer,
  isClosing,
  DISCONNECT_GRACE_MS,
  CLOSE_GRACE_MS,
} from './room-registry'

// ---------------------------------------------------------------------------
// Connection lifecycle: rejoinProbe, leaveRoom, disconnect (+ grace window)
// ---------------------------------------------------------------------------

export function registerLifecycleHandlers(ctx: HandlerContext): void {
  const { io, socket, session } = ctx

  // -----------------------------------------------------------------------
  // Internal helper — remove a peer from its room and notify everyone.
  // The heavy lifting (presenter cleanup, peerLeft broadcast, peerSockets +
  // room cleanup) lives in evictPeer so the sendBeacon HTTP endpoint and the
  // grace-window timers can reuse the exact same logic.
  // -----------------------------------------------------------------------
  function handleLeave(roomId: string, peerId: string): void {
    evictPeer(io, roomId, peerId)
    socket.leave(roomId)
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

    // If the client explicitly told us it was closing (sendBeacon on
    // pagehide/beforeunload), evict on the short window so the other
    // participants don't wait out the full grace period. Otherwise this looks
    // like a network drop / phone lock and we keep the generous grace.
    const graceMs = isClosing(peerId) ? CLOSE_GRACE_MS : DISCONNECT_GRACE_MS
    const timer = setTimeout(() => {
      deletePendingDisconnect(peerId)
      // Re-check: the peer may have reconnected on a new socket meanwhile.
      if (peerSockets.get(peerId) !== socket.id) return
      console.log(`[room] Peer ${peerId} did not return within grace window — evicting`)
      evictPeer(io, roomId, peerId)
    }, graceMs)
    scheduleEviction(peerId, timer)
  })
}
