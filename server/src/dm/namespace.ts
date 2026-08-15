import type { Server, Socket } from 'socket.io'
import { isDmEnabled, validateSessionToken } from './db'
import { registerDmHandlers } from './handlers'
import {
  cancelCallCleanup,
  registerCallHandlers,
  scheduleCallCleanup,
  syncCallsForSocket,
} from './call-handlers'
import {
  broadcastCurrentStatus,
  isOnline,
  setSocketStatus,
  startPresenceSweeper,
  trackConnect,
  trackDisconnect,
  trackPing,
} from './presence'
import { userRoom, type DmSocketData } from './namespace-types'
import type { SocketStatus } from './presence'

/**
 * Достать статус вкладки из чего угодно, что прислал клиент: handshake, dm:ping,
 * dm:status. Всё три источника недоверенные и приходят одинаковой формы, поэтому
 * разбор один. undefined означает «клиент статуса не сообщил» — так ведёт себя
 * старый бандл из кэша браузера, и для него presence должен работать как раньше.
 */
function readStatus(value: unknown): SocketStatus | undefined {
  return value === 'online' || value === 'idle' || value === 'hidden' ? value : undefined
}

// ---------------------------------------------------------------------------
// Namespace /dm — личные сообщения между друзьями.
//
// Полностью изолирован от корневого namespace (комнаты/звонки): свой
// auth-middleware, свои события, своё хранилище. Ломать звонки он не может.
// ---------------------------------------------------------------------------

export function setupDmNamespace(io: Server): void {
  if (!isDmEnabled()) {
    console.warn('[dm] DATABASE_URL не задан — личный чат отключён (namespace /dm не поднят).')
    return
  }

  const nsp = io.of('/dm')

  // --- Аутентификация: токен сессии Better Auth из handshake --------------
  nsp.use(async (socket, next) => {
    const raw = (socket.handshake.auth as Record<string, unknown> | undefined)?.token
    const token = typeof raw === 'string' ? raw : ''
    if (!token) {
      next(new Error('unauthorized'))
      return
    }

    const identity = await validateSessionToken(token)
    if (!identity) {
      next(new Error('unauthorized'))
      return
    }

    const data = socket.data as DmSocketData
    data.userId = identity.userId
    data.name = identity.name
    data.username = identity.username
    next()
  })

  nsp.on('connection', (socket: Socket) => {
    const data = socket.data as DmSocketData
    const userId = data.userId
    if (!userId) {
      socket.disconnect(true)
      return
    }

    // Личная комната пользователя — адрес доставки для всех его устройств.
    void socket.join(userRoom(userId))
    console.log(`[dm] Подключён ${userId} (socket ${socket.id})`)

    registerDmHandlers(nsp, socket)
    registerCallHandlers(nsp, socket)

    // Пользователь вернулся раньше, чем истёк grace-период после разрыва:
    // отменяем отложенную уборку, иначе она погасила бы живой звонок.
    cancelCallCleanup(userId)

    // join уже выполнен, поэтому снапшот presence гарантированно дойдёт.
    //
    // Статус вкладки берём из handshake: вкладка могла открыться сразу в фоне
    // (Ctrl+click, восстановление сессии браузера) или это реконнект свёрнутого
    // окна. Без него presence обязан был предполагать 'online', и у друзей
    // мигала зелёная точка, тут же сменяясь на «был(а) только что».
    const initialStatus = readStatus(
      (socket.handshake.auth as Record<string, unknown> | undefined)?.status,
    )
    void trackConnect(nsp, socket, userId, initialStatus)

    // Досылаем этому устройству звонки, которые уже идут: `call:incoming`
    // рассылался один раз, и подключившийся посреди звонка о нём бы не узнал.
    syncCallsForSocket(socket, userId)

    // --- Прикладной heartbeat presence ------------------------------------
    // Свой пинг поверх движкового нужен потому, что pingTimeout у Socket.IO —
    // 30 секунд, и понижать его нельзя: на нём держится устойчивость звонков к
    // мигнувшей сети. Presence же должен реагировать за секунды, поэтому у него
    // отдельный, более чуткий таймер (см. PING_TIMEOUT_MS в presence.ts).
    socket.on('dm:ping', (payload: unknown) => {
      // Пинг НЕСЁТ СОСТОЯНИЕ ВКЛАДКИ, а не только факт «я жив».
      //
      // Благодаря этому presence самовосстанавливается: каждый heartbeat — это
      // полная правда о вкладке, поэтому потерянное dm:status, реконнект или
      // понижение статуса свипером исправляются сами на следующем пинге. Без
      // этого расхождение могло держаться до перезагрузки страницы.
      //
      // Статуса может и не быть (старый бандл из кэша браузера) — тогда пинг
      // работает как раньше, просто продлевая жизнь соединения.
      const status = readStatus((payload as { status?: unknown } | undefined)?.status)

      if (trackPing(userId, socket.id, status)) {
        void broadcastCurrentStatus(nsp, userId)
      }
    })

    // Вкладка сообщает, что пользователь отошёл, вернулся или ушёл в фон.
    // Статус хранится на каждый сокет: сводный считается по всем устройствам,
    // поэтому свёрнутая вкладка на ноутбуке не гасит активность на телефоне.
    socket.on('dm:status', (payload: unknown) => {
      const status = readStatus((payload as { status?: unknown } | undefined)?.status)
      if (!status) return
      void setSocketStatus(nsp, socket, userId, status)
    })

    socket.on('disconnect', () => {
      trackDisconnect(nsp, socket.id, userId)
      // Учёт соединений trackDisconnect правит синхронно (до первого await),
      // поэтому isOnline здесь уже отвечает про состояние ПОСЛЕ разрыва.
      // Ушло последнее соединение — незавершённые звонки надо погасить, иначе у
      // собеседника входящий вызов остался бы висеть до таймаута. Но не сразу:
      // reload и мигнувшая сеть тоже рвут websocket, поэтому даём шанс
      // вернуться, а вернувшемуся состояние досылает syncCallsForSocket.
      if (!isOnline(userId)) scheduleCallCleanup(nsp, userId)
      console.log(`[dm] Отключён ${userId} (socket ${socket.id})`)
    })
  })

  // Фоновая уборка замолчавших соединений: ловит убитый браузер и пропавшую
  // сеть, о которых disconnect не приходит или приходит слишком поздно.
  startPresenceSweeper(nsp)

  console.log('[dm] Namespace /dm поднят')
}
