import type { Server, Socket } from 'socket.io'
import { isDmEnabled, validateSessionToken } from './db'
import { registerDmHandlers } from './handlers'
import { endCallsForUser, registerCallHandlers } from './call-handlers'
import { isOnline, trackConnect, trackDisconnect } from './presence'
import { userRoom, type DmSocketData } from './namespace-types'

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

    // join уже выполнен, поэтому снапшот presence гарантированно дойдёт.
    void trackConnect(nsp, socket, userId)

    socket.on('disconnect', () => {
      void trackDisconnect(nsp, socket, userId)
      // Учёт соединений trackDisconnect правит синхронно (до первого await),
      // поэтому isOnline здесь уже отвечает про состояние ПОСЛЕ разрыва.
      // Ушло последнее соединение — незавершённые звонки надо погасить, иначе у
      // собеседника входящий вызов остался бы висеть до таймаута.
      if (!isOnline(userId)) endCallsForUser(nsp, userId)
      console.log(`[dm] Отключён ${userId} (socket ${socket.id})`)
    })
  })

  console.log('[dm] Namespace /dm поднят')
}
