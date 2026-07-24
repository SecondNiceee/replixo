import type { Namespace, Socket } from 'socket.io'
import { listFriendIds } from './db'
import { userRoom } from './namespace-types'

// ---------------------------------------------------------------------------
// Presence личного чата: кто сейчас онлайн.
//
// Состояние — in-memory, потому что сервер один процесс (как и реестр комнат
// в socket/rooms). Для нескольких инстансов понадобится Redis-адаптер
// Socket.IO — отмечено в плане как задел на будущее.
//
// Ключевая деталь: у одного пользователя может быть несколько соединений
// (вкладки, телефон). Онлайн он ровно до тех пор, пока жив хотя бы один
// сокет, поэтому храним МНОЖЕСТВО socketId, а события online/offline
// отправляем только на переходах 0 → 1 и 1 → 0. Иначе закрытие второй
// вкладки гасило бы точку у собеседника.
// ---------------------------------------------------------------------------

/** userId → его живые socketId. */
const connections = new Map<string, Set<string>>()

/** userId → когда пользователь ушёл в оффлайн (мс). */
const lastSeen = new Map<string, number>()

/** Кэш списка друзей: адресатов presence спрашиваем часто, меняются они редко. */
const FRIENDS_TTL_MS = 30_000
const friendsCache = new Map<string, { ids: string[]; at: number }>()

async function friendsOf(userId: string): Promise<string[]> {
  const cached = friendsCache.get(userId)
  const now = Date.now()
  if (cached && now - cached.at < FRIENDS_TTL_MS) return cached.ids
  const ids = await listFriendIds(userId)
  friendsCache.set(userId, { ids, at: now })
  return ids
}

export function isOnline(userId: string): boolean {
  return (connections.get(userId)?.size ?? 0) > 0
}

/**
 * Регистрирует соединение. Если оно первое у пользователя — рассылает друзьям
 * `dm:presence {online:true}`. Затем отдаёт этому сокету снапшот: какие из его
 * друзей онлайн и когда остальных видели последний раз.
 */
export async function trackConnect(
  nsp: Namespace,
  socket: Socket,
  userId: string,
): Promise<void> {
  let sockets = connections.get(userId)
  const isFirst = !sockets || sockets.size === 0
  if (!sockets) {
    sockets = new Set()
    connections.set(userId, sockets)
  }
  sockets.add(socket.id)

  const friends = await friendsOf(userId)

  if (isFirst) {
    lastSeen.delete(userId)
    for (const friendId of friends) {
      nsp.to(userRoom(friendId)).emit('dm:presence', { userId, online: true })
    }
  }

  const onlineUserIds = friends.filter(isOnline)
  const lastSeenAt: Record<string, number> = {}
  for (const friendId of friends) {
    const seen = lastSeen.get(friendId)
    if (seen !== undefined) lastSeenAt[friendId] = seen
  }
  socket.emit('dm:presence:snapshot', { onlineUserIds, lastSeenAt })
}

/**
 * Снимает соединение с учёта. Оффлайн объявляем только когда у пользователя
 * не осталось ни одного сокета.
 */
export async function trackDisconnect(
  nsp: Namespace,
  socket: Socket,
  userId: string,
): Promise<void> {
  const sockets = connections.get(userId)
  if (!sockets) return
  sockets.delete(socket.id)
  if (sockets.size > 0) return

  connections.delete(userId)
  const at = Date.now()
  lastSeen.set(userId, at)

  const friends = await friendsOf(userId)
  for (const friendId of friends) {
    nsp.to(userRoom(friendId)).emit('dm:presence', {
      userId,
      online: false,
      lastSeenAt: at,
    })
  }
}
