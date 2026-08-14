import type { Express, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import type { Server } from 'socket.io'
import { isDmEnabled, validateSessionToken } from './db'
import { trackDisconnect } from './presence'

// ---------------------------------------------------------------------------
// Beacon «я закрываю вкладку» для presence личного чата.
//
// Зачем отдельный HTTP-маршрут, если есть событие disconnect: при выгрузке
// страницы socket.emit доставить уже нельзя — браузер убивает соединения, не
// дожидаясь отправки. Сервер узнаёт о разрыве только по своему pingTimeout, а
// это 30 секунд (socket.ts), и всё это время собеседник видит «в сети» у
// человека, который давно ушёл. Именно это и было главной жалобой.
//
// navigator.sendBeacon, наоборот, гарантированно доставляется во время
// выгрузки. Тот же приём уже используется для выхода из комнаты
// (POST /rooms/:roomId/leave в index.ts) — здесь он повторён для /dm.
//
// Отличие от beacon'а комнат: там участник задаётся peerId из query, здесь
// нужна аутентификация. Иначе кто угодно смог бы «выключить» произвольного
// пользователя, отправив один POST с его id. Поэтому личность берётся ИСКЛЮЧИТЕЛЬНО
// из токена сессии, а не из тела запроса.
//
// Токен передаётся в теле, а не в query: URL пишется в логи nginx, и токен
// сессии в них попадать не должен. sendBeacon умеет отправлять Blob с
// Content-Type: text/plain, поэтому тело парсим вручную — express.json() на
// такой content-type не срабатывает.
// ---------------------------------------------------------------------------

/** Токен сессии Better Auth — заметно короче, чем этот лимит. */
const MAX_TOKEN_LENGTH = 512

/**
 * Лимит на неудачные попытки. Маршрут публичный, а внутри — обращение к БД для
 * валидации токена: без лимита это дешёвый способ нагрузить Postgres перебором.
 * Успешные вызовы не считаем — их частота ограничена самими пользователями
 * (один beacon на закрытие вкладки).
 */
const LEAVE_LIMITER = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  // За прокси req.ip одинаков для всех, поэтому считаем неудачи общим ведром —
  // так же, как в internal-routes.ts. Честнее, чем изображать per-IP.
  keyGenerator: () => 'dm-presence-leave',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
})

/** Достать токен из тела: sendBeacon шлёт text/plain, express.json() молчит. */
function readToken(req: Request): string {
  const body: unknown = req.body
  // express.json() всё же сработал (обычный fetch с application/json).
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const raw = (body as Record<string, unknown>).token
    return typeof raw === 'string' ? raw : ''
  }
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : ''
  if (!raw) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const token = (parsed as Record<string, unknown>).token
      return typeof token === 'string' ? token : ''
    }
  } catch {
    // Не JSON — значит тело прислали как сырой токен.
    return raw.trim()
  }
  return ''
}

export function registerPresenceRoutes(app: Express, io: Server): void {
  if (!isDmEnabled()) return

  const nsp = io.of('/dm')

  app.post(
    '/dm/presence/leave',
    // text/plain от sendBeacon express.json() не разбирает — принимаем сырое тело.
    (req, res, next) => {
      if (req.is('application/json')) {
        next()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        // Тело здесь — это один короткий токен. Всё, что больше, читать незачем.
        if (size > MAX_TOKEN_LENGTH * 4) {
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        req.body = Buffer.concat(chunks)
        next()
      })
      req.on('error', () => {
        if (!res.headersSent) res.status(204).end()
      })
    },
    LEAVE_LIMITER,
    (req: Request, res: Response) => {
      void (async () => {
        const token = readToken(req)
        const socketId = typeof req.query.socketId === 'string' ? req.query.socketId : ''

        // Ответ beacon'у никто не читает: страница уже выгружается. Поэтому на
        // любую проблему отвечаем 204 и просто ничего не делаем — но статус для
        // rate-limiter'а важен, поэтому неудачи помечаем 4xx.
        if (!token || token.length > MAX_TOKEN_LENGTH) {
          res.status(400).end()
          return
        }

        const identity = await validateSessionToken(token)
        if (!identity) {
          res.status(401).end()
          return
        }

        // socketId нужен, чтобы снять с учёта именно ту вкладку, которая
        // закрывается: у пользователя могут быть открыты другие, и они должны
        // остаться онлайн. Без него закрытие одной вкладки гасило бы все.
        if (socketId) {
          // immediate: закрытие вкладки — осознанный уход, ждать возврата
          // (grace-окно) незачем, точка у собеседника гаснет сразу.
          trackDisconnect(nsp, socketId, identity.userId, true)
        }

        res.status(204).end()
      })().catch((e: unknown) => {
        console.error('[dm] presence/leave failed:', (e as Error).message)
        if (!res.headersSent) res.status(500).end()
      })
    },
  )
}
