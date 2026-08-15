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

/**
 * Состояние ОДНОЙ вкладки. Наружу не торчит: собеседнику уходит сводный
 * PresenceStatus.
 *
 *   • online — вкладка видима, человек что-то делал недавно.
 *   • idle   — вкладка видима, но человек молчит дольше минуты («отошёл»).
 *   • hidden — вкладка ушла в фон (переключились на другую, свернули окно).
 *              Соединение живо (звонки и сообщения доходят), но для друзей это
 *              РАВНО оффлайну: человек Riplexo не смотрит, и правильный ответ на
 *              вопрос «он на месте?» — «был в сети только что», а не зелёная
 *              точка. Поэтому статус вкладки и наличие сокета здесь сознательно
 *              разведены: sweeper/звонки смотрят на сокет (isOnline), UI — на
 *              statusOf.
 */
export type SocketStatus = 'online' | 'idle' | 'hidden'

interface SocketPresence {
  /** Что сообщила о себе сама вкладка. */
  status: SocketStatus
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

/**
 * После какой тишины СЧИТАЕМ ВКЛАДКУ ФОНОВОЙ, даже если она об этом не сообщила.
 *
 * Это независимая от клиентских событий страховка, и держится она на том, что
 * браузеры душат таймеры в фоновых вкладках: активная вкладка присылает пинг
 * каждые 7 секунд (PING_INTERVAL_MS), а свёрнутая или неактивная — не чаще
 * раза в минуту. Значит сама РЕДКОСТЬ пингов уже доказывает, что человек не
 * смотрит на страницу.
 *
 * Зачем, если есть dm:status: то событие — единственный источник правды о фоне,
 * и стоит ему не дойти (потерялось на реконнекте, сервер ещё не знает о нём,
 * старый бандл в кэше браузера), как человек навсегда остаётся «в сети» с живым
 * сокетом. Тишина же не может «не дойти» — её видно всегда.
 *
 * 30 секунд — это четыре пропущенных пинга подряд: активная вкладка так
 * замолчать не может даже на плохой сети, а фоновая переступает порог всегда.
 */
const PRESENCE_STALE_MS = 30_000

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
 * Сводный статус пользователя: online, если активна хотя бы одна вкладка; idle,
 * если все видимые вкладки отметились отошедшими; offline, если все вкладки в
 * фоне (или их нет вовсе).
 *
 * Вкладки в фоне не участвуют в подсчёте намеренно: иначе открытая в соседнем
 * табе страница Riplexo держала бы зелёную точку неделями.
 */
export function statusOf(userId: string): PresenceStatus {
  const sockets = connections.get(userId)
  if (!sockets || sockets.size === 0) return 'offline'
  let idle = false
  for (const presence of sockets.values()) {
    if (presence.status === 'online') return 'online'
    if (presence.status === 'idle') idle = true
  }
  return idle ? 'idle' : 'offline'
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
 * Регистрирует соединение. Если сводный статус пользователя из-за этого
 * изменился — рассылает его друзьям. Затем отдаёт этому сокету снапшот: статусы
 * его друзей и время последнего присутствия остальных.
 *
 * `initialStatus` приезжает в handshake (см. use-dm-socket) и нужен для вкладок,
 * которые открываются сразу в фоне: Ctrl+click, восстановление сессии браузера,
 * реконнект свёрнутого окна. Раньше здесь безусловно ставился 'online', и такое
 * подключение давало у друзей вспышку зелёной точки, которую следующее же
 * dm:status сменяло на «был(а) только что». Значение по умолчанию оставлено
 * ради старого бандла из кэша браузера, который статус не присылает.
 */
export async function trackConnect(
  nsp: Namespace,
  socket: Socket,
  userId: string,
  initialStatus: SocketStatus = 'online',
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
  // Именно сводный статус, а не «есть ли сокеты»: у пользователя могли остаться
  // только свёрнутые вкладки, и для друзей он в этот момент оффлайн.
  const statusBefore = statusOf(userId)
  if (!sockets) {
    sockets = new Map()
    connections.set(userId, sockets)
  }
  sockets.set(socket.id, { status: initialStatus, lastPingAt: now })

  // Пользователь здесь и сейчас — фиксируем сразу, не дожидаясь первого
  // периодического сброса: короткая сессия иначе не оставила бы времени.
  // Открытая в фоне вкладка тоже считается: страницу всё-таки загрузили, и
  // «был(а) только что» — правильный ответ, даже если точка не зажглась.
  flushLastSeen(userId, now, true)

  const friends = await friendsOf(userId)

  // Рассылаем только когда сводный статус реально изменился. Вторая активная
  // вкладка ничего не меняет для друзей, а вот новая вкладка при остальных
  // свёрнутых (сводный статус был offline) — меняет. И наоборот: фоновая вкладка
  // при отсутствии других статус не меняет вовсе, поэтому и события нет.
  const statusAfter = statusOf(userId)
  if (statusAfter !== statusBefore) {
    for (const friendId of friends) {
      nsp.to(userRoom(friendId)).emit('dm:presence', { userId, status: statusAfter })
    }
  }

  // lastSeenAt читаем из БД: в памяти его больше нет, и именно поэтому снапшот
  // тепер�� остаётся содержательным после рестарта сервера.
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
  status?: SocketStatus,
): boolean {
  const sockets = connections.get(userId)
  const presence = sockets?.get(socketId)
  if (!presence) return false

  const before = statusOf(userId)
  presence.lastPingAt = Date.now()
  if (status) presence.status = status
  const after = statusOf(userId)
  // lastSeenAt двигаем только пока человек действительно у экрана. Пинги от
  // свёрнутых вкладок сюда тоже приходят (соединение живо), и если бы они
  // обновляли время, у друзей навсегда осталось бы «был(а) только что» вместо
  // растущего «N минут назад».
  if (after !== 'offline') flushLastSeen(userId, presence.lastPingAt)
  return after !== before
}

/**
 * Сменить статус вкладки и разослать сводный статус, если он изменился.
 *
 * Переход в оффлайн (все вкладки свернули) уходит вместе с lastSeenAt и
 * принудительно фиксируется в БД: клиент по этому времени рисует «был(а) в сети
 * только что», а перезагрузка страницы собеседника берёт то же значение из
 * снапшота.
 */
export async function setSocketStatus(
  nsp: Namespace,
  socket: Socket,
  userId: string,
  status: SocketStatus,
): Promise<void> {
  if (!trackPing(userId, socket.id, status)) return
  await broadcastCurrentStatus(nsp, userId)
}

/**
 * Разослать друзьям текущий сводный статус. Оффлайн (например, все вкладки
 * ушли в фон при живых соединениях) всегда уходит вместе с lastSeenAt и
 * принудительной записью в БД: по этому времени UI рисует «был(а) в сети только
 * что», и то же значение потом приходит в снапшоте после перезагрузки.
 */
export async function broadcastCurrentStatus(nsp: Namespace, userId: string): Promise<void> {
  const status = statusOf(userId)
  if (status !== 'offline') {
    await broadcastStatus(nsp, userId, status)
    return
  }
  const at = Date.now()
  flushLastSeen(userId, at, true)
  await broadcastStatus(nsp, userId, 'offline', at)
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
      const silentFor = now - presence.lastPingAt
      if (silentFor <= PING_TIMEOUT_MS) continue

      const live = nsp.sockets.get(socketId)
      if (live?.connected) {
        // Соединение живо, но вкладка замолчала. Раньше здесь просто
        // переписывалось lastPingAt = now — и это была дыра: любая вкладка с
        // живым сокетом бесконечно считалась активной, поэтому свёрнутый
        // браузер оставался «в сети», пока не закроют окно.
        //
        // Теперь редкость пингов трактуется как фон (см. PRESENCE_STALE_MS).
        // Сам сокет не трогаем: сообщения и звонки по нему должны доходить.
        if (silentFor >= PRESENCE_STALE_MS && presence.status !== 'hidden') {
          presence.status = 'hidden'
          changed = true
        }
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
      // Остались соединения, но сводный статус мог стать любым, включая offline
      // (все выжившие вкладки в фоне) — тогда helper приложит lastSeenAt.
      void broadcastCurrentStatus(nsp, userId)
    }
  }
}

/** Запустить фоновый свипер. Вызывается один раз при поднятии namespace /dm. */
export function startPresenceSweeper(nsp: Namespace): void {
  const timer = setInterval(() => sweepStaleSockets(nsp), SWEEP_INTERVAL_MS)
  // unref, чтобы таймер не держал процесс при graceful shutdown.
  timer.unref()
}
