import { saveMessage, saveReadMarker } from '../db'
import type { ChatMessagePayload, ChatReadPayload } from '../types'
import { createRateLimiter, type HandlerContext } from './helpers'
import { rooms, peerSockets } from './room-registry'

// ---------------------------------------------------------------------------
// Room text chat: chatMessage, chatRead
// ---------------------------------------------------------------------------

export function registerChatHandlers(ctx: HandlerContext): void {
  const { socket } = ctx

  // -----------------------------------------------------------------------
  // chatMessage  (a peer sent a text message to the room)
  //
  // The client emits this whenever a participant sends a message. The server
  // validates + authenticates the sender, rate-limits, assigns a canonical
  // id/timestamp and broadcasts to every OTHER peer in the room. The sender
  // adds its own message optimistically (mirrors the slide-sync pattern), so
  // we use socket.to() — not io.to() — to avoid echoing it back.
  // -----------------------------------------------------------------------
  const MAX_TEXT_LENGTH = 2000
  // Sliding-window rate-limit: max 5 messages per 2 seconds per socket.
  const allowChatEvent = createRateLimiter(5, 2000)

  socket.on('chatMessage', (payload: unknown) => {
    // --- Input validation ---
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid, text, id: clientId, attachment } = payload as ChatMessagePayload
    if (typeof rid !== 'string' || !rid) return
    if (typeof pid !== 'string' || !pid) return
    if (typeof text !== 'string') return

    const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)

    // --- Validate attachment (optional) ---
    // url должен указывать строго в папку вложений ЭТОЙ комнаты —
    // защита от подделки ссылок на чужие/произвольные файлы.
    let safeAttachment: ChatMessagePayload['attachment'] | undefined
    if (attachment != null) {
      if (typeof attachment !== 'object') return
      const { url, name, size, mime } = attachment
      const expectedPrefix = `/uploads/${rid}/`
      if (
        typeof url !== 'string' ||
        !url.startsWith(expectedPrefix) ||
        url.includes('..') ||
        typeof name !== 'string' ||
        typeof size !== 'number' ||
        !Number.isFinite(size) ||
        size < 0 ||
        typeof mime !== 'string'
      ) {
        return
      }
      safeAttachment = {
        url,
        name: name.slice(0, 255),
        size,
        mime: mime.slice(0, 128),
      }
    }

    // Сообщение должно нести хоть что-то: текст или вложение.
    if (!trimmed && !safeAttachment) return

    // --- Auth: sender must own this peerId in this room ---
    const room = rooms.get(rid)
    if (!room) return
    const peer = room.getPeer(pid)
    if (!peer) return
    if (peerSockets.get(pid) !== socket.id) return

    // --- Rate limit ---
    if (!allowChatEvent()) return

    const now = Date.now()

    // Reuse the sender's client-generated id when it looks valid so the
    // optimistic copy and the persisted/broadcast record share one id.
    // Falls back to a server id otherwise.
    const id =
      typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64
        ? clientId
        : `${now}-${Math.random().toString(36).slice(2, 8)}`

    const message = {
      id,
      roomId: rid,
      peerId: pid,
      displayName: peer.displayName,
      text: trimmed,
      attachment: safeAttachment ?? null,
      timestamp: now,
    }

    // Persist (no-op when DATABASE_URL is unset). Fire-and-forget.
    void saveMessage(message)

    socket.to(rid).emit('chatMessage', {
      id: message.id,
      peerId: message.peerId,
      displayName: message.displayName,
      text: message.text,
      attachment: message.attachment,
      timestamp: message.timestamp,
    })
  })

  // -----------------------------------------------------------------------
  // chatRead  (a peer has read the chat up to a given timestamp)
  //
  // Emitted when the recipient has the chat panel open AND the tab visible.
  // We persist the marker (no-op without DATABASE_URL) and broadcast it to
  // the OTHER peers so senders can flip their messages to "read".
  // -----------------------------------------------------------------------
  socket.on('chatRead', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { roomId: rid, peerId: pid, ts } = payload as ChatReadPayload
    if (typeof rid !== 'string' || !rid) return
    if (typeof pid !== 'string' || !pid) return
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return

    // --- Auth: sender must own this peerId in this room ---
    const room = rooms.get(rid)
    if (!room) return
    if (!room.hasPeer(pid)) return
    if (peerSockets.get(pid) !== socket.id) return

    // Persist (fire-and-forget) and tell the others.
    void saveReadMarker(rid, pid, ts)
    socket.to(rid).emit('chatRead', { peerId: pid, ts })
  })
}
