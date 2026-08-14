// Должен идти первым: патчит console, чтобы каждая строка логов имела дату/время.
import './logger'
import 'dotenv/config'
import http from 'http'
import path from 'path'
import { randomUUID } from 'crypto'
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import * as mediasoup from 'mediasoup'
import fs from 'fs'
import {
  PORT,
  CLIENT_ORIGIN,
  workerSettings,
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  UPLOAD_TTL_MS,
  WINDOWS_INSTALLER_PATH,
  WINDOWS_INSTALLER_NAME,
} from './config'
import { setupSocketIO } from './socket'
import { canonicalRoomCode } from './room-code'
import { evictPeer, markClosing, scheduleEviction, getPeerSocket, CLOSE_GRACE_MS } from './socket/room-registry'
import {
  ensureUploadRoot,
  ensureRoomDir,
  sweepOrphanUploads,
} from './uploads'
import {
  contentDisposition,
  decodeOriginalName,
  safeAttachmentName,
} from './upload-filename'
import { isDmEnabled, isMember, validateSessionToken } from './dm/db'
import { registerInternalRoutes } from './dm/internal-routes'
import {
  allowDmUpload,
  dmUrlPrefix,
  ensureDmConversationDir,
  isValidConversationId,
} from './dm/uploads'

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Express + HTTP server
  // ---------------------------------------------------------------------------
  const app = express()

  app.use(cors({ origin: CLIENT_ORIGIN }))
  app.use(express.json())

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  // ---------------------------------------------------------------------------
  // Вложения чата (файлы на диске VPS)
  // ---------------------------------------------------------------------------
  ensureUploadRoot()

  // Раздача загруженных файлов. Заголовки безопасности:
  //  - nosniff: браузер не угадывает тип (иначе загруженный .html мог бы
  //    выполниться как страница);
  //  - не-картинки отдаём как attachment (скачивание), картинки — inline, чтобы
  //    показывать превью прямо в чате.
  app.use(
    '/uploads',
    express.static(UPLOAD_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Cache-Control', 'private, max-age=86400')
        const ext = path.extname(filePath).toLowerCase()
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'].includes(ext)
        if (!isImage) {
          // На диске файл называется UUID'ом, поэтому без явного имени браузер
          // сохранил бы «a1b2….pdf». Клиент передаёт исходное имя в ?name=;
          // отдаём его через RFC 5987 (filename*), чтобы кириллица дожила до
          // диалога сохранения (атрибут download работает только same-origin).
          res.setHeader('Content-Disposition', contentDisposition(res.req?.query?.name))
        }
      },
    }),
  )

  // Загрузка файла в папку конкретной комнаты. multer кладёт файл на диск с
  // безопасным случайным именем; оригинальное имя возвращается клиенту и
  // хранится в сообщении.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const roomId = canonicalRoomCode(req.params.roomId)
      if (!roomId) {
        cb(new Error('invalid roomId'), '')
        return
      }
      req.params.roomId = roomId
      try {
        cb(null, ensureRoomDir(roomId))
      } catch (e) {
        cb(e as Error, '')
      }
    },
    filename: (_req, file, cb) => {
      // Имя от busboy приходит в latin1 — расширение берём из исправленного,
      // иначе кириллица в нём («…копия.таблица») превратилась бы в мохибаку.
      const ext = path.extname(decodeOriginalName(file.originalname)).slice(0, 16)
      cb(null, `${randomUUID()}${ext}`)
    },
  })

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  })

  app.post(
    '/rooms/:roomId/upload',
    (req: Request, res: Response) => {
      const roomId = canonicalRoomCode(req.params.roomId)
      if (!roomId) {
        res.status(400).json({ error: 'invalid roomId' })
        return
      }
      upload.single('file')(req, res, (uploadErr: unknown) => {
        if (uploadErr) {
          const message = (uploadErr as Error).message ?? 'upload failed'
          const tooLarge = message.includes('File too large')
          res.status(tooLarge ? 413 : 400).json({
            error: tooLarge ? 'Файл слишком большой' : message,
          })
          return
        }
        const file = req.file
        if (!file) {
          res.status(400).json({ error: 'no file' })
          return
        }
        // URL относительный — клиент сам подставит адрес сервера. Декодировать
        // не нужно: имя — это сгенерированный UUID + расширение.
        res.json({
          url: `/uploads/${roomId}/${file.filename}`,
          name: safeAttachmentName(file.originalname),
          size: file.size,
          mime: file.mimetype || 'application/octet-stream',
        })
      })
    },
  )

  // ---------------------------------------------------------------------------
  // Вложения личных чатов: POST /dm/:conversationId/upload
  //
  // В отличие от /rooms/:roomId/upload здесь авторизация ОБЯЗАТЕЛЬНА: комната —
  // это одноразовый код, который знают только участники звонка, а диалог живёт
  // постоянно и его id вычислим из пары userId. Проверяем в таком порядке:
  //   формат id → сессия → membership → rate limit → и только затем пишем файл.
  // Порядок важен: multer начинает писать на диск сразу, поэтому все отказы
  // должны случиться до него, иначе неавторизованный запрос уже занял место.
  // ---------------------------------------------------------------------------
  const dmStorage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const conversationId = req.params.conversationId
      if (!isValidConversationId(conversationId)) {
        cb(new Error('invalid conversationId'), '')
        return
      }
      try {
        cb(null, ensureDmConversationDir(conversationId))
      } catch (e) {
        cb(e as Error, '')
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(decodeOriginalName(file.originalname)).slice(0, 16)
      cb(null, `${randomUUID()}${ext}`)
    },
  })

  const dmUpload = multer({
    storage: dmStorage,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  })

  app.post('/dm/:conversationId/upload', (req: Request, res: Response) => {
    void (async () => {
      const conversationId = req.params.conversationId
      if (!isValidConversationId(conversationId)) {
        res.status(400).json({ error: 'invalid conversationId' })
        return
      }
      if (!isDmEnabled()) {
        res.status(503).json({ error: 'Чат недоступен' })
        return
      }

      // Токен сессии передаёт Next-прокси (/api/chat/upload): браузер не имеет
      // доступа к httpOnly-cookie, а кросс-доменный cookie сюда не долетит.
      const header = req.header('authorization') ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      if (!token) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const identity = await validateSessionToken(token)
      if (!identity) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      if (!(await isMember(conversationId, identity.userId))) {
        res.status(403).json({ error: 'Нет доступа к диалогу' })
        return
      }

      if (!allowDmUpload(identity.userId)) {
        res.status(429).json({ error: 'Слишком много файлов, попробуйте позже' })
        return
      }

      dmUpload.single('file')(req, res, (uploadErr: unknown) => {
        if (uploadErr) {
          const message = (uploadErr as Error).message ?? 'upload failed'
          const tooLarge = message.includes('File too large')
          res.status(tooLarge ? 413 : 400).json({
            error: tooLarge ? 'Файл слишком большой' : message,
          })
          return
        }
        const file = req.file
        if (!file) {
          res.status(400).json({ error: 'no file' })
          return
        }
        // Именно этот префикс потом проверяет dm:send — ссылка привязана к
        // диалогу, так что подставить чужую не получится.
        res.json({
          url: `${dmUrlPrefix(conversationId)}${file.filename}`,
          name: safeAttachmentName(file.originalname),
          size: file.size,
          mime: file.mimetype || 'application/octet-stream',
        })
      })
    })().catch((e: unknown) => {
      console.error('[dm] upload failed:', (e as Error).message)
      if (!res.headersSent) res.status(500).json({ error: 'upload failed' })
    })
  })

  // ---------------------------------------------------------------------------
  // Скачивание установщика приложения (Windows .exe, ~900 МБ).
  //
  // Файл лежит на диске VPS (WINDOWS_INSTALLER_PATH) и НЕ хранится в git.
  // res.download() использует модуль send: он сам выставляет Content-Length,
  // Accept-Ranges и обрабатывает Range-запросы — то есть поддерживает докачку
  // и докачивание после обрыва, что критично для большого файла.
  // ---------------------------------------------------------------------------
  app.get('/download/windows', (_req: Request, res: Response) => {
    fs.access(WINDOWS_INSTALLER_PATH, fs.constants.R_OK, (err) => {
      if (err) {
        console.error(
          `[download] Установщик не найден: ${WINDOWS_INSTALLER_PATH}`,
        )
        res.status(404).json({ error: 'Установщик временно недоступен' })
        return
      }
      res.download(WINDOWS_INSTALLER_PATH, WINDOWS_INSTALLER_NAME, (dlErr) => {
        // Частая «ошибка» — клиент оборвал соединение (закрыл вкладку/пауза).
        // Это не повод шуметь в логах как о настоящей проблеме.
        if (dlErr && !res.headersSent) {
          console.error('[download] Ошибка отдачи установщика:', dlErr.message)
        }
      })
    })
  })

  const httpServer = http.createServer(app)

  // ---------------------------------------------------------------------------
  // Mediasoup Worker
  // ---------------------------------------------------------------------------
  const worker = await mediasoup.createWorker(workerSettings)

  worker.on('died', (error) => {
    console.error('[mediasoup] Worker died, exiting in 2 seconds...', error)
    setTimeout(() => process.exit(1), 2000)
  })

  console.log(`[mediasoup] Worker created (pid: ${worker.pid})`)

  // ---------------------------------------------------------------------------
  // Socket.io
  // ---------------------------------------------------------------------------
  const io = setupSocketIO(httpServer, worker)

  // Маршруты «Next-сервер → сокет-сервер». Регистрируются после io, потому что
  // им нужен namespace /dm для рассылки. Защищены общим секретом.
  registerInternalRoutes(app, io)

  // ---------------------------------------------------------------------------
  // "Я закрываю вкладку" — beacon от клиента (navigator.sendBeacon на
  // pagehide/beforeunload). sendBeacon надёжно доставляется во время выгрузки
  // страницы, в отличие от socket.emit. Мы НЕ удаляем участника мгновенно:
  // ставим короткое окно CLOSE_GRACE_MS, чтобы перезагрузка страницы или
  // случайный быстрый возврат успели отменить удаление через
  // rejoinProbe/joinRoom. Реальное закрытие вкладки/браузера — никто не
  // вернётся, и остальные увидят выход почти сразу (а не через полное
  // grace-окно, как при обычном обрыве сети). sendBeacon шлёт POST; мы читаем
  // peerId из query, те��а нет — парсер не нужен.
  // ---------------------------------------------------------------------------
  app.post('/rooms/:roomId/leave', (req: Request, res: Response) => {
    const roomId = canonicalRoomCode(req.params.roomId)
    const peerId = typeof req.query.peerId === 'string' ? req.query.peerId : ''
    if (!roomId || !peerId) {
      res.status(204).end()
      return
    }
    markClosing(roomId, peerId)
    const expectedSocketId = getPeerSocket(roomId, peerId)
    const timer = setTimeout(() => {
      // A newer socket generation always wins over this stale beacon.
      if (getPeerSocket(roomId, peerId) !== expectedSocketId) return
      const activeSocket = expectedSocketId ? io.sockets.sockets.get(expectedSocketId) : undefined
      if (activeSocket?.connected) return
      evictPeer(io, roomId, peerId, expectedSocketId)
    }, CLOSE_GRACE_MS)
    scheduleEviction(roomId, peerId, timer)
    // Ответ телу sendBeacon не важен — отвечаем сразу.
    res.status(204).end()
  })

  // ---------------------------------------------------------------------------
  // Фоновая подчистка осиротевших вложений (защита диска от утечки места).
  // Запускаем при старте и далее раз в час.
  // ---------------------------------------------------------------------------
  void sweepOrphanUploads()
  const sweepTimer = setInterval(() => {
    void sweepOrphanUploads()
  }, Math.min(UPLOAD_TTL_MS, 60 * 60 * 1000))
  sweepTimer.unref()

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  httpServer.listen(PORT, () => {
    console.log(`[server] Replixo mediasoup server running on port ${PORT}`)
    console.log(`[server] CORS allowed origin: ${CLIENT_ORIGIN}`)
    console.log(`[server] Uploads dir: ${UPLOAD_DIR} (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB/file)`)
  })

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = (): void => {
    console.log('[server] Shutting down...')
    clearInterval(sweepTimer)
    worker.close()
    httpServer.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('[server] Fatal error:', e)
  process.exit(1)
})
