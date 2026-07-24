import type { Namespace, Socket } from 'socket.io'
import { createRateLimiter } from '../socket/helpers'
import { areFriends, insertMessage } from './db'
import { userRoom, otherUserIdFrom, type DmSocketData } from './namespace-types'

// ---------------------------------------------------------------------------
// События личного чата. Авторство берётся ТОЛЬКО из socket.data.userId,
// который выставлен auth-middleware по токену сессии. Ничего из payload,
// касающегося личности отправителя, не используется.
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 4000
const MAX_ID_LENGTH = 64
const MAX_CONVERSATION_ID_LENGTH = 128

type Ack = (res: { ok: true; id: string; createdAt: number } | { ok: false; error: string }) => void

function respond(cb: unknown, payload: Parameters<Ack>[0]): void {
  if (typeof cb === 'function') (cb as Ack)(payload)
}

export function registerDmHandlers(nsp: Namespace, socket: Socket): void {
  const data = socket.data as DmSocketData
  // Скользящее окно: 10 сообщений за 2 секунды на соединение.
  const allowSend = createRateLimiter(10, 2000)

  socket.on('dm:send', async (payload: unknown, cb?: unknown) => {
    const senderId = data.userId
    if (!senderId) {
      respond(cb, { ok: false, error: 'unauthorized' })
      socket.disconnect(true)
      return
    }

    if (!payload || typeof payload !== 'object') {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }
    const { conversationId, id, text } = payload as Record<string, unknown>

    if (
      typeof conversationId !== 'string' ||
      !conversationId ||
      conversationId.length > MAX_CONVERSATION_ID_LENGTH
    ) {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }
    if (typeof text !== 'string') {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }

    const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)
    if (!trimmed) {
      respond(cb, { ok: false, error: 'empty' })
      return
    }

    if (!allowSend()) {
      respond(cb, { ok: false, error: 'rate_limited' })
      return
    }

    // Для 1:1 писать можно только принятому другу. Историю читать после
    // удаления дружбы всё ещё можно, а писать — нет.
    const peerId = otherUserIdFrom(conversationId, senderId)
    if (peerId) {
      const friends = await areFriends(senderId, peerId)
      if (!friends) {
        respond(cb, { ok: false, error: 'not_friends' })
        return
      }
    }

    // Membership проверяется внутри транзакции: null = не участник.
    const stored = await insertMessage({ id, conversationId, senderId, text: trimmed })
    if (!stored) {
      respond(cb, { ok: false, error: 'not_member' })
      return
    }

    respond(cb, { ok: true, id, createdAt: stored.createdAt })

    // Повторную отправку не рассылаем второй раз — получатели её уже видели.
    if (stored.duplicate) return

    const message = {
      id,
      senderId,
      senderName: data.name ?? '',
      text: trimmed,
      attachment: null,
      createdAt: stored.createdAt,
    }

    // Доставляем во все устройства всех участников (включая отправителя —
    // так вторая вкладка тоже увидит сообщение; дубли гасит дедуп по id).
    for (const memberId of stored.memberIds) {
      nsp.to(userRoom(memberId)).emit('dm:message', { conversationId, message })
    }
  })
}
