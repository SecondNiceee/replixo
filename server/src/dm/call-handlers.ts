import { randomUUID } from 'node:crypto'
import type { Namespace, Socket } from 'socket.io'
import { createRateLimiter } from '../socket/helpers'
import { areFriends } from './db'
import { isOnline } from './presence'
import { userRoom, type DmSocketData } from './namespace-types'

// ---------------------------------------------------------------------------
// Звонок из личного чата: «позвонить другу» → у него на экране входящий вызов
// → принял, и оба оказываются в одной комнате.
//
// Состояние — in-memory, как presence и реестр комнат: звонок живёт секунды,
// переживать перезапуск сервера ему незачем, а после перезапуска все websocket
// всё равно порваны и звонить уже некому.
//
// Комнату здесь НЕ создаём: корневой namespace поднимает её на первом
// joinRoom. Мы лишь заранее договариваемся о коде, чтобы оба участника пришли
// в одну и ту же комнату — иначе принявшему пришлось бы получать код отдельным
// сообщением.
// ---------------------------------------------------------------------------

/** Сколько звонить, прежде чем сдаться. */
const RING_TIMEOUT_MS = 45_000

/** Без похожих друг на друга символов: код диктуют голосом и вводят руками. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface PendingCall {
  callId: string
  roomId: string
  fromUserId: string
  fromName: string
  toUserId: string
  timer: ReturnType<typeof setTimeout>
}

/** callId → звонок в состоянии «звоним». */
const pending = new Map<string, PendingCall>()

function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) code += '-'
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

function forget(call: PendingCall): void {
  clearTimeout(call.timer)
  pending.delete(call.callId)
}

/** Звонок между этой парой уже идёт? Повторный клик не должен звонить дважды. */
function findBetween(fromUserId: string, toUserId: string): PendingCall | null {
  for (const call of pending.values()) {
    if (call.fromUserId === fromUserId && call.toUserId === toUserId) return call
  }
  return null
}

/**
 * Завершить все звонки пользователя. Вызывается, когда у него не осталось ни
 * одного соединения: без этого закрытая вкладка звонящего оставила бы
 * собеседника с вечным входящим вызовом на экране.
 */
export function endCallsForUser(nsp: Namespace, userId: string): void {
  for (const call of [...pending.values()]) {
    if (call.fromUserId !== userId && call.toUserId !== userId) continue
    forget(call)
    const otherId = call.fromUserId === userId ? call.toUserId : call.fromUserId
    nsp.to(userRoom(otherId)).emit('call:ended', { callId: call.callId, reason: 'gone' })
    // И собственным устройствам того, кто ушёл: они могли остаться открытыми.
    nsp.to(userRoom(userId)).emit('call:ended', { callId: call.callId, reason: 'gone' })
  }
}

type Ack = (res: Record<string, unknown>) => void

function respond(cb: unknown, payload: Record<string, unknown>): void {
  if (typeof cb === 'function') (cb as Ack)(payload)
}

function readCallId(payload: unknown): string | null {
  const { callId } = (payload ?? {}) as Record<string, unknown>
  return typeof callId === 'string' && callId.length > 0 && callId.length <= 64 ? callId : null
}

export function registerCallHandlers(nsp: Namespace, socket: Socket): void {
  const data = socket.data as DmSocketData
  // Звонок — действие редкое и дорогое: пять попыток за десять секунд с
  // запасом покрывают «нажал ещё раз, потому что не дозвонился».
  const allowInvite = createRateLimiter(5, 10_000)
  const allowAnswer = createRateLimiter(20, 10_000)

  // --- Позвонить ---------------------------------------------------------
  socket.on('call:invite', async (payload: unknown, cb?: unknown) => {
    const fromUserId = data.userId
    if (!fromUserId) {
      respond(cb, { ok: false, error: 'unauthorized' })
      return
    }
    if (!allowInvite()) {
      respond(cb, { ok: false, error: 'rate_limited' })
      return
    }

    const { peerId } = (payload ?? {}) as Record<string, unknown>
    if (typeof peerId !== 'string' || !peerId || peerId.length > 64 || peerId === fromUserId) {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }

    // Звонить можно только принятому другу — то же правило, что и на отправку
    // сообщений. Иначе звонок стал бы каналом для навязчивых незнакомцев.
    if (!(await areFriends(fromUserId, peerId))) {
      respond(cb, { ok: false, error: 'not_friends' })
      return
    }

    if (!isOnline(peerId)) {
      respond(cb, { ok: false, error: 'offline' })
      return
    }

    // Повторный клик по кнопке: отдаём тот же звонок, второй раз не звоним.
    const existing = findBetween(fromUserId, peerId)
    if (existing) {
      respond(cb, { ok: true, callId: existing.callId, roomId: existing.roomId })
      return
    }

    const callId = randomUUID()
    const roomId = generateRoomCode()
    const fromName = data.username ?? data.name ?? ''

    const call: PendingCall = {
      callId,
      roomId,
      fromUserId,
      fromName,
      toUserId: peerId,
      timer: setTimeout(() => {
        pending.delete(callId)
        nsp.to(userRoom(peerId)).emit('call:ended', { callId, reason: 'timeout' })
        nsp.to(userRoom(fromUserId)).emit('call:ended', { callId, reason: 'timeout' })
      }, RING_TIMEOUT_MS),
    }
    pending.set(callId, call)

    // Во все устройства адресата: звонок должен догнать его там, где он есть.
    nsp.to(userRoom(peerId)).emit('call:incoming', {
      callId,
      roomId,
      fromUserId,
      fromName,
      createdAt: Date.now(),
    })

    respond(cb, { ok: true, callId, roomId })
    console.log(`[call] ${fromUserId} → ${peerId} room=${roomId} call=${callId}`)
  })

  // --- Принять ----------------------------------------------------------
  socket.on('call:accept', (payload: unknown, cb?: unknown) => {
    const userId = data.userId
    const callId = readCallId(payload)
    if (!userId || !callId || !allowAnswer()) {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }

    const call = pending.get(callId)
    // Принять может только адресат: иначе звонящий мог бы «ответить сам себе»
    // и затащить собеседника в комнату без его согласия.
    if (!call || call.toUserId !== userId) {
      respond(cb, { ok: false, error: 'not_found' })
      return
    }

    forget(call)

    // Обеим сторонам, во все устройства: у звонящего гаснет «звоним…» и он
    // уходит в комнату, у принявшего закрываются остальные вкладки с вызовом.
    const accepted = { callId, roomId: call.roomId }
    nsp.to(userRoom(call.fromUserId)).emit('call:accepted', accepted)
    nsp.to(userRoom(call.toUserId)).emit('call:accepted', accepted)

    respond(cb, { ok: true, roomId: call.roomId })
    console.log(`[call] accepted room=${call.roomId} call=${callId}`)
  })

  // --- Отклонить / отменить ---------------------------------------------
  // Одно событие на оба случая: разница только в том, кто его прислал, а
  // проверку «участник этого звонка» всё равно делать одинаковую.
  socket.on('call:hangup', (payload: unknown, cb?: unknown) => {
    const userId = data.userId
    const callId = readCallId(payload)
    if (!userId || !callId || !allowAnswer()) {
      respond(cb, { ok: false, error: 'bad_payload' })
      return
    }

    const call = pending.get(callId)
    if (!call || (call.fromUserId !== userId && call.toUserId !== userId)) {
      respond(cb, { ok: false, error: 'not_found' })
      return
    }

    forget(call)

    // Причина зависит от того, кто нажал: звонящий отменил вызов, адресат
    // отклонил. Клиент по ней выбирает текст уведомления.
    const reason = call.fromUserId === userId ? 'cancelled' : 'declined'
    nsp.to(userRoom(call.fromUserId)).emit('call:ended', { callId, reason })
    nsp.to(userRoom(call.toUserId)).emit('call:ended', { callId, reason })

    respond(cb, { ok: true })
    console.log(`[call] ${reason} room=${call.roomId} call=${callId}`)
  })
}
