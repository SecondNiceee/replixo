import type { Namespace, Socket } from 'socket.io'
import { getLastSeenBulk, listFriendIds, touchLastSeen } from './db'
import { userRoom } from './namespace-types'

// ---------------------------------------------------------------------------
// Presence личного чата: кто сейчас онлайн, кто отошёл, когда его видели.
//
// Разделение источников истины — главное решение этого модуля:
//
//   • СТАТУС (online/idle) — in-memory. Он эфемерен по определению: живёт ровно
//     столько, сколько живёт соединение, и умереть вместе с процессом для него
//     нормально (нет процесса — нет и соединений).
//
//   • lastSeenAt — Postgres ("user"."lastSeenAt"). Это ИСТОРИЯ, и в памяти она
//     терялась при каждом деплое: значение появлялось только в момент
//     дисконнекта, поэтому после рестарта все друзья показывались как «не в
//     сети» вообще без времени.
//
// Почему не Redis: пока сокет-сервер — один процесс (см. nginx.md: proxy_pass
// на 127.0.0.1:3001 без upstream-блока), Redis не добавил бы ничего, кроме
// сетевого хопа и новой точки отказа. Хуже: его TTL-ключи ПЕРЕЖИВАЮТ падение
// процесса, поэтому после краха интерфейс показывал бы «онлайн» у людей без
// соединения — ровно тот баг, от которого этот модуль уходит. Память же
// не может пережить процесс, которому принадлежит.
//
// Наружу торчит узкий интерфейс (isOnline / statusOf / statusesFor / track*),
// вся память спрятана внутри файла. Когда появится второй инстанс, замена на
// Redis-адаптер затронет только этот файл и socket.ts.
//
// Ключевая деталь: у одного пользователя может быть несколько соединений
// (вкладки, телефон). Поэтому статус хранится НА КАЖДЫЙ СОКЕТ, а итоговый
// считается сводно: online, если активна хотя бы одна вкладка; idle, если все
// отошли. Иначе закрытие второй вкладки гасило бы точку у собеседника.
// ---------------------------------------------------------------------------

/** Что видит собеседник. 'offline' наружу отдаётся, но в памяти не хранится. */
export type PresenceStatus = 'online' | 'idle' | 'offline'

interface SocketPresence {
  /** Сам пользователь отметил вкладку активной или отошедшей. */
  status: 'online' | 'idle'
  /** Время последнего прикладного heartbeat — по нему свипер ловит мертвецов. */
  lastPingAt: number
}

/** userId → (socketId → состояние этого соединения). */
const connections = new Map<string, Map<string, SocketPresence>>()

/**
 * Отложенное объявление оффлайна: userId → таймер.
 *
 * Перезагрузка страницы и мигнувшая сеть рвут websocket так же, как настоящий
 * уход, поэтому мгновенный оффлайн давал бы мигание точки у собеседника на
 * каждый F5. Grace-окно (по образцу RECONNECT_GRACE_MS в call-handlers) ждёт
 * возможного возврата. Важно: в lastSeenAt пишется момент РАЗРЫВА, а не момент
 * истечения таймера — иначе «был(а) только что» отставало бы на grace.
 */
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>()

const OFFLINE_GRACE_MS = 8_000

/**
 * Как часто пишем lastSeenAt, пока пользователь онлайн.
 *
 * Это страховка от жёсткого падения процесса (kill -9, OOM): при штатном
 * разрыве время пишет trackDisconnect, но если процесс умрёт мгновенно, без
 * периодического сброса времени не осталось бы вовсе. 60 секунд — потолок
 * погрешности «был(а) N минут назад», незаметный в UI, но и не создающий
 * заметной нагрузки на БД (один UPDATE по первичному ключу на пользователя).
 */
const LAST_SEEN_FLUSH_MS = 60_000

/** userId → когда последний раз сбрасывали lastSeenAt в БД (throttle). */
const lastFlushAt = new Map<string, number>()

/**
 * Порог живости прикладного heartbeat.
 *
 * Зачем он вообще, если у Socket.IO есть свой ping: pingTimeout у движка — 30
 * секунд (socket.ts), и понижать его нельзя, на нём держится устойчивость
 * звонков к мигнувшей сети. Поэтому у presence свой, более чуткий таймер:
 * клиент шлёт `dm:ping` каждые PING_INTERVAL_MS, а свипер считает соединение
 * мёртвым для presence через PING_TIMEOUT_MS тишины. Сам сокет при этом НЕ
 * рвём — им распоряжается движок и звонки.
 *
 * Порог с запасом больше интервала: один потерянный пинг на плохой сети не
 * должен гасить точку.
 */
const PING_TIMEOUT_MS = 15_000
const SWEEP_INTERVAL_MS = 5_000

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

/**
 * Есть ли у пользователя хотя бы одно живое соединение.
 *
 * Сознательно НЕ различает online и idle: этим предикатом пользуются звонки
 * (call-handlers), а отошедший от клавиатуры человек в звонке — всё ещё в
 * звонке. Для отображения статуса есть statusOf.
 */
export function isOnline(userId: string): boolean {
  return (connections.get(userId)?.size ?? 0) > 0
}

/**
 * Сводный статус пользователя: online, если активна хотя бы одна вкладка;
 * idle, если соединения есть, но все отметились отошедшими.
 */
export function statusOf(userId: string): PresenceStatus {
  const sockets = connections.get(userId)
  if (!sockets || sockets.size === 0) return 'offline'
  for (const presence of sockets.values()) {
    if (presence.status === 'online') return 'online'
  }
  return 'idle'
}

/** Статусы сразу для списка пользователей — для снапшота и /internal/presence. */
export function statusesFor(userIds: string[]): Record<string, PresenceStatus> {
  const result: Record<string, PresenceStatus> = {}
  for (const id of userIds) {
    const status = statusOf(id)
    // Оффлайн не передаём: это состояние по умолчанию, а пустые поля дешевле
    // и на проводе, и при слиянии на клиенте.
    if (status !== 'offline') result[id] = status
  }
  return result
}

/**
 * Сбросить кэш друзей пользователя. Нужен, когда состав друзей изменился
 * (приняли заявку, удалили из друзей): иначе до FRIENDS_TTL_MS новый друг не
 * получал бы событий presence, а удалённый продолжал бы их получать.
 */
export function invalidateFriendsCache(userId: string): void {
  friendsCache.delete(userId)
}

/** Разослать статус пользователя всем его друзьям. */
async function broadcastStatus(
  nsp: Namespace,
  userId: string,
  status: PresenceStatus,
  lastSeenAt?: number,
): Promise<void> {
  const friends = await friendsOf(userId)
  for (const friendId of friends) {
    nsp.to(userRoom(friendId)).emit('dm:presence', { userId, status, lastSeenAt })
  }
}

/**
 * Взаимно объявить presence двум пользователям. Вызывается сразу после
 * подтверждения дружбы: снапшот они получили при подключении, когда друзьями
 * ещё не были, поэтому иначе точка «в сети» появилась бы только после reload.
 */
export function announceMutualPresence(nsp: Namespace, a: string, b: string): void {
  const statusA = statusOf(a)
  const statusB = statusOf(b)
  if (statusB !== 'offline') nsp.to(userRoom(a)).emit('dm:presence', { userId: b, status: statusB })
  if (statusA !== 'offline') nsp.to(userRoom(b)).emit('dm:presence', { userId: a, status: statusA })
}

/** Записать lastSeenAt, но не чаще LAST_SEEN_FLUSH_MS (кроме force). */
function flushLastSeen(userId: string, at: number, force = false): void {
  if (!force && at - (lastFlushAt.get(userId) ?? 0) < LAST_SEEN_FLUSH_MS) return
  lastFlushAt.set(userId, at)
  void touchLastSeen(userId, at)
}

/**
 * Регистрирует соединение. Если оно первое у пользователя — рассылает друзьям
 * статус. Затем отдаёт этому сокету снапшот: статусы его друзей и время
 * последнего присутствия остальных.
 */
export async function trackConnect(
  nsp: Namespace,
  socket: Socket,
  userId: string,
): Promise<void> {
  const now = Date.now()

  // Вернулся внутри grace-окна — отменяем отложенный оффлайн. Собеседник в
  // этом случае вообще не увидел разрыва: reload проходит незаметно.
  const pendingOffline = offlineTimers.get(userId)
  if (pendingOffline) {
    clearTimeout(pendingOffline)
    offlineTimers.delete(userId)
  }

  let sockets = connections.get(userId)
  const wasOffline = !sockets || sockets.size === 0
  if (!sockets) {
    sockets = new Map()
    connections.set(userId, sockets)
  }
  sockets.set(socket.id, { status: 'online', lastPingAt: now })

  // Пользователь здесь и сейчас — фиксируем сразу, не дожидаясь первого
  // периодического сброса: короткая сессия иначе не оставила бы времени.
  flushLastSeen(userId, now, true)

  const friends = await friendsOf(userId)

  // Рассылаем только на переходе offline → online. Вторая вкладка того же
  // пользователя ничего не меняет для его друзей.
  if (wasOffline) {
    for (const friendId of friends) {
      nsp.to(userRoom(friendId)).emit('dm:presence', { userId, status: 'online' })
    }
  }

  // lastSeenAt читаем из БД: в памяти его больше нет, и именно поэтому снапшот
  // теперь остаётся содержательным после рестарта сервера.
  const [statuses, lastSeenAt] = await Promise.all([
    Promise.resolve(statusesFor(friends)),
    getLastSeenBulk(friends),
  ])

  socket.emit('dm:presence:snapshot', { statuses, lastSeenAt })
}

/**
 * Отметить активность соединения (прикладной heartbeat) и, опционально,
 * сменить статус вкладки. Возвращает true, если сводный статус изменился и его
 * нужно разослать.
 */
export function trackPing(
  userId: string,
  socketId: string,
  status?: 'online' | 'idle',
): boolean {
  const sockets = connections.get(userId)
  const presence = sockets?.get(socketId)
  if (!presence) return false

  const before = statusOf(userId)
  presence.lastPingAt = Date.now()
  if (status) presence.status = status
  // Пользователь активен — поддерживаем lastSeenAt свежим (throttle внутри).
  flushLastSeen(userId, presence.lastPingAt)
  return statusOf(userId) !== before
}

/** Сменить статус вкладки и разослать сводный статус, если он изменился. */
export async function setSocketStatus(
  nsp: Namespace,
  socket: Socket,
  userId: string,
  status: 'online' | 'idle',
): Promise<void> {
  if (!trackPing(userId, socket.id, status)) return
  await broadcastStatus(nsp, userId, statusOf(userId))
}

/**
 * Снимает соединение с учёта. Оффлайн объявляем только когда у пользователя не
 * осталось ни одного сокета — и не мгновенно, а после grace-окна.
 *
 * `immediate` — для beacon'а при закрытии вкладки: там уход осознанный, ждать
 * возврата не нужно, и точка у собеседника гаснет сразу.
 *
 * Учёт соединений правится СИНХРОННО, до первого await: на это опирается
 * namespace.ts, где сразу после вызова проверяется isOnline для уборки звонков.
 */
export function trackDisconnect(
  nsp: Namespace,
  socketId: string,
  userId: string,
  immediate = false,
): void {
  const sockets = connections.get(userId)
  if (!sockets) return
  sockets.delete(socketId)
  if (sockets.size > 0) return

  connections.delete(userId)

  // Время разрыва фиксируем сейчас, а не когда истечёт grace: иначе «был(а)
  // только что» отставало бы на длину окна.
  const at = Date.now()
  flushLastSeen(userId, at, true)
  lastFlushAt.delete(userId)

  const announceOffline = () => {
    offlineTimers.delete(userId)
    // Мог вернуться, пока таймер ждал — тогда объявлять оффлайн нечего.
    if (isOnline(userId)) return
    void broadcastStatus(nsp, userId, 'offline', at)
  }

  if (immediate) {
    const pending = offlineTimers.get(userId)
    if (pending) {
      clearTimeout(pending)
      offlineTimers.delete(userId)
    }
    announceOffline()
    return
  }

  if (offlineTimers.has(userId)) return
  offlineTimers.set(userId, setTimeout(announceOffline, OFFLINE_GRACE_MS))
}

/**
 * Убрать соединения, замолчавшие дольше PING_TIMEOUT_MS.
 *
 * Ловит случаи, когда disconnect не приходит вовсе или приходит слишком поздно:
 * убитый процесс браузера, спящий ноутбук, пропавшая сеть. Движок заметит это
 * лишь через свой pingTimeout (30 с), а здесь важна реакция за секунды.
 *
 * Оффлайн объявляем без grace: тишина дольше PING_TIMEOUT_MS уже сама себе
 * grace-окно, ждать ещё восемь секунд незачем.
 */
function sweepStaleSockets(nsp: Namespace): void {
  const now = Date.now()
  for (const [userId, sockets] of connections) {
    let changed = false
    for (const [socketId, presence] of sockets) {
      if (now - presence.lastPingAt <= PING_TIMEOUT_MS) continue
      // Сокет мог просто не поддерживать наш heartbeat (старый клиент из
      // закэшированного бандла): проверяем, что соединения действительно нет,
      // прежде чем гасить точку.
      const live = nsp.sockets.get(socketId)
      if (live?.connected) {
        presence.lastPingAt = now
        continue
      }
      sockets.delete(socketId)
      changed = true
    }
    if (!changed) continue
    if (sockets.size === 0) {
      connections.delete(userId)
      lastFlushAt.delete(userId)
      const at = now
      flushLastSeen(userId, at, true)
      void broadcastStatus(nsp, userId, 'offline', at)
    } else {
      void broadcastStatus(nsp, userId, statusOf(userId))
    }
  }
}

/** Запустить фоновый свипер. Вызывается один раз при поднятии namespace /dm. */
export function startPresenceSweeper(nsp: Namespace): void {
  const timer = setInterval(() => sweepStaleSockets(nsp), SWEEP_INTERVAL_MS)
  // unref, чтобы таймер не держал процесс при graceful shutdown.
  timer.unref()
}
