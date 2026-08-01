import type { Namespace, Socket } from 'socket.io'
import { createRateLimiter } from '../socket/helpers'
import {
  areFriends,
  friendLinkState,
  insertMessage,
  isMember,
  listMemberIds,
  markRead,
  userExists,
  type DmAttachment,
} from './db'
import { broadcastFriendsChanged, type FriendsChangeReason } from './friends-events'
import { userRoom, otherUserIdFrom, type DmSocketData } from './namespace-types'
import { isDmAttachmentUrl } from './uploads'

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

const MAX_NAME_LENGTH = 255
const MAX_MIME_LENGTH = 128

function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= MAX_CONVERSATION_ID_LENGTH
}

/**
 * Причина изменения для фолбэк-пути. Клиент её не присылает (доверять ему тут
 * нечему), поэтому выводим из фактического статуса связи в БД. На основном пути
 * причину передаёт Next-роут — он точно знает, какое действие выполнил.
 */
function reasonFromStatus(status: string): FriendsChangeReason {
  if (status === 'accepted') return 'accepted'
  if (status === 'declined') return 'declined'
  // Строки нет — заявку отменили или друга удалили. Обе причины перечитывают
  // один и тот же набор ключей, поэтому различать их здесь незачем.
  if (status === 'none') return 'removed'
  return 'requested'
}

/**
 * Разбор вложения из payload.
 *
 * `undefined` — вложения нет (это нормально).
 * `null`      — вложение прислали, но оно невалидное → сообщение отбрасываем.
 *
 * Главная проверка — url указывает строго в папку ЭТОГО диалога. Файл уже лежит
 * на диске (его загрузил авторизованный POST /dm/:id/upload), поэтому без этой
 * привязки клиент мог бы подставить ссылку на вложение чужой переписки.
 */
function parseAttachment(
  raw: unknown,
  conversationId: string,
): DmAttachment | null | undefined {
  if (raw == null) return undefined
  if (typeof raw !== 'object') return null

  const { url, name, size, mime } = raw as Record<string, unknown>
  if (typeof url !== 'string' || !isDmAttachmentUrl(url, conversationId)) return null
  if (typeof name !== 'string' || !name) return null
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null
  if (typeof mime !== 'string' || !mime) return null

  return {
    url,
    name: name.slice(0, MAX_NAME_LENGTH),
    size,
    mime: mime.slice(0, MAX_MIME_LENGTH),
  }
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
    const { conversationId, id, text, attachment } = payload as Record<string, unknown>

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

    const safeAttachment = parseAttachment(attachment, conversationId)
    if (safeAttachment === null) {
      respond(cb, { ok: false, error: 'bad_attachment' })
      return
    }

    const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH)
    // Сообщение должно нести хоть что-то: текст или вложение. Файл без подписи
    // — обычный случай, поэтому пустой текст сам по себе не ошибка.
    if (!trimmed && !safeAttachment) {
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
    const stored = await insertMessage({
      id,
      conversationId,
      senderId,
      text: trimmed,
      attachment: safeAttachment ?? null,
    })
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
      attachment: safeAttachment ?? null,
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

  // --- Изменилась дружба (ФОЛБЭК) ---------------------------------------
  // Основной путь рассылки — POST /internal/friends/changed: его дёргает
  // Next-роут сразу после записи в БД, поэтому realtime не зависит от того,
  // есть ли у инициатора живой websocket. Это событие остаётся страховкой на
  // случай, когда внутренний хук не настроен (нет INTERNAL_HOOK_SECRET) или
  // недоступен, и клиент сообщает об изменении сам.
  //
  // Защита от амплификации: событие несёт только «перечитай списки», поэтому
  // достаточно, чтобы адресат существовал, а частота была ограничена
  // `allowMeta` (40 за 2 с на соединение). Требовать существующую связь нельзя:
  // отмена заявки и удаление из друзей УДАЛЯЮТ строку, и к моменту события
  // статус уже 'none' — а именно тогда второму участнику и нужно сообщить.
  socket.on('dm:friends:changed', async (payload: unknown, cb?: unknown) => {
    const userId = data.userId
    if (!userId) return
    // Событие редкое: заявка/принятие/удаление. Спамить им нечего.
    if (!allowMeta()) return

    const { peerId } = (payload ?? {}) as Record<string, unknown>
    if (typeof peerId !== 'string' || !peerId || peerId.length > MAX_ID_LENGTH) return
    if (peerId === userId) return
    if (!(await userExists(peerId))) return

    const link = await friendLinkState(userId, peerId)

    // Причину выводим из фактического статуса: клиент её не присылает.
    // status === 'none' здесь означает удалённую строку, то есть
    // отмену заявки или удаление из друзей.
    //
    // socket.id — источник действия: эхо гасим по соединению, а не по
    // пользователю, иначе вторая вкладка инициатора осталась бы со старыми
    // списками (она ничего не перечитывала, но событие бы выбросила).
    await broadcastFriendsChanged(
      nsp,
      userId,
      peerId,
      reasonFromStatus(link.status),
      null,
      socket.id,
    )

    respond(cb, { ok: true, id: peerId, createdAt: Date.now() })
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
