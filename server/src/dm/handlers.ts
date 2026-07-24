import type { Namespace, Socket } from 'socket.io'
import { createRateLimiter } from '../socket/helpers'
import { areFriends, insertMessage, isMember, listMemberIds, markRead } from './db'
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

function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= MAX_CONVERSATION_ID_LENGTH
}

export function registerDmHandlers(nsp: Namespace, socket: Socket): void {
  const data = socket.data as DmSocketData
  // Скользящее окно: 10 сообщений за 2 секунды на соединение.
  const allowSend = createRateLimiter(10, 2000)
  // Служебные события (read/typing) летят чаще, но и стоят дешевле.
  const allowMeta = createRateLimiter(40, 2000)

  // Membership меняется только в сторону «стал участником», поэтому
  // положительный ответ можно кэшировать на время жизни соединения и не
  // ходить в БД на каждое нажатие клавиши.
  const confirmedMembership = new Set<string>()
  const ensureMember = async (conversationId: string, userId: string): Promise<boolean> => {
    if (confirmedMembership.has(conversationId)) return true
    const ok = await isMember(conversationId, userId)
    if (ok) confirmedMembership.add(conversationId)
    return ok
  }

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

  // --- Прочитано --------------------------------------------------------
  // Рассылаем ВСЕМ участникам, включая самого читателя: его другие устройства
  // должны погасить счётчик непрочитанных синхронно.
  socket.on('dm:read', async (payload: unknown) => {
    const userId = data.userId
    if (!userId || !allowMeta()) return

    const { conversationId, ts } = (payload ?? {}) as Record<string, unknown>
    if (!isConversationId(conversationId)) return

    // Метку времени берём из payload, но не даём уехать в будущее: иначе
    // клиент мог бы «прочитать» сообщения, которых ещё нет.
    const now = Date.now()
    const at = typeof ts === 'number' && Number.isFinite(ts) ? Math.min(ts, now) : now

    const res = await markRead(conversationId, userId, at)
    if (!res) return // не участник — молча игнорируем

    for (const memberId of res.memberIds) {
      nsp.to(userRoom(memberId)).emit('dm:read', { conversationId, userId, ts: res.ts })
    }
  })

  // --- «Печатает…» ------------------------------------------------------
  // Событие эфемерное: в БД не пишется, автосброс — на стороне клиента.
  socket.on('dm:typing', async (payload: unknown) => {
    const userId = data.userId
    if (!userId || !allowMeta()) return

    const { conversationId, typing } = (payload ?? {}) as Record<string, unknown>
    if (!isConversationId(conversationId) || typeof typing !== 'boolean') return

    if (!(await ensureMember(conversationId, userId))) return

    // Себе не отправляем: индикатор нужен только собеседнику.
    for (const memberId of await listMemberIds(conversationId)) {
      if (memberId === userId) continue
      nsp.to(userRoom(memberId)).emit('dm:typing', { conversationId, userId, typing })
    }
  })
}
