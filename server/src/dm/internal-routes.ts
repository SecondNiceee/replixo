import { timingSafeEqual } from 'crypto'
import type { Express, Request, Response } from 'express'
import type { Server } from 'socket.io'
import { INTERNAL_HOOK_SECRET } from '../config'
import { isDmEnabled, userExists } from './db'
import { broadcastFriendsChanged, type FriendsChangeReason } from './friends-events'

// ---------------------------------------------------------------------------
// Внутренние маршруты «Next-сервер → сокет-сервер».
//
// Зачем: заявки в друзья пишет Next-API в Postgres, а этот процесс об изменении
// не узнаёт. Раньше о нём сообщал браузер инициатора через socket-событие — то
// есть realtime работал только когда у инициатора был живой websocket. Теперь
// основной путь идёт через сервер: Next-роут после успешного UPDATE дёргает
// POST /internal/friends/changed, и оба участника получают событие независимо от
// состояния клиентских соединений.
//
// Доступ: только по общему секрету в заголовке x-internal-secret. Секрет никогда
// не попадает в браузер (переменная без префикса NEXT_PUBLIC_), а сравнение —
// constant-time, чтобы по времени ответа его нельзя было подобрать побайтово.
// ---------------------------------------------------------------------------

function isAuthorized(req: Request): boolean {
  if (!INTERNAL_HOOK_SECRET) return false
  const raw = req.header('x-internal-secret') ?? ''
  const a = Buffer.from(raw)
  const b = Buffer.from(INTERNAL_HOOK_SECRET)
  // timingSafeEqual требует равной длины, а сама длина секрета не тайна.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const REASONS: readonly FriendsChangeReason[] = [
  'requested',
  'accepted',
  'declined',
  'cancelled',
  'removed',
]

function isReason(value: unknown): value is FriendsChangeReason {
  return typeof value === 'string' && (REASONS as readonly string[]).includes(value)
}

const MAX_ID_LENGTH = 64

function isId(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= MAX_ID_LENGTH
}

export function registerInternalRoutes(app: Express, io: Server): void {
  if (!INTERNAL_HOOK_SECRET) {
    console.warn(
      '[internal] INTERNAL_HOOK_SECRET не задан — /internal/* отключён, ' +
        'realtime дружбы работает через фолбэк на socket-событии.',
    )
  }

  app.post('/internal/friends/changed', (req: Request, res: Response) => {
    void (async () => {
      if (!isAuthorized(req)) {
        // 503 без секрета и 401 при неверном: пусть Next-роут различает
        // «хук не настроен» и «настроен неправильно» — второе стоит починить.
        res.status(INTERNAL_HOOK_SECRET ? 401 : 503).json({ error: 'unauthorized' })
        return
      }
      if (!isDmEnabled()) {
        res.status(503).json({ error: 'dm_disabled' })
        return
      }

      const { userId, peerId, reason } = (req.body ?? {}) as Record<string, unknown>
      if (!isId(userId) || !isId(peerId) || userId === peerId) {
        res.status(400).json({ error: 'bad_payload' })
        return
      }
      if (!isReason(reason)) {
        res.status(400).json({ error: 'bad_reason' })
        return
      }

      // Оба id приходят от доверенного Next-роута, но существование проверяем:
      // рассылать в комнату несуществующего пользователя незачем.
      if (!(await userExists(userId)) || !(await userExists(peerId))) {
        res.status(404).json({ error: 'user_not_found' })
        return
      }

      const link = await broadcastFriendsChanged(io.of('/dm'), userId, peerId, reason)
      res.json({ ok: true, status: link.status })
    })().catch((e: unknown) => {
      console.error('[internal] friends/changed failed:', (e as Error).message)
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    })
  })
}
