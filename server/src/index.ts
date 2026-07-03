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
import { evictPeer, markClosing, scheduleEviction, CLOSE_GRACE_MS } from './socket/room-registry'
import {
  ensureUploadRoot,
  ensureRoomDir,
  isValidRoomId,
  sweepOrphanUploads,
} from './uploads'

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
        if (!isImage) res.setHeader('Content-Disposition', 'attachment')
      },
    }),
  )

  // Загрузка файла в папку конкретной комнаты. multer кладёт файл на диск с
  // безопасным случайным именем; оригинальное имя возвращается клиенту и
  // хранится в сообщении.
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const roomId = req.params.roomId
      if (!isValidRoomId(roomId)) {
        cb(new Error('invalid roomId'), '')
        return
      }
      try {
        cb(null, ensureRoomDir(roomId))
      } catch (e) {
        cb(e as Error, '')
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 16)
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
      const { roomId } = req.params
      if (!isValidRoomId(roomId)) {
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
          name: file.originalname.slice(0, 255),
          size: file.size,
          mime: file.mimetype || 'application/octet-stream',
        })
      })
    },
  )

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

  // ---------------------------------------------------------------------------
  // "Я закрываю вкладку" — beacon от клиента (navigator.sendBeacon на
  // pagehide/beforeunload). sendBeacon надёжно доставляется во время выгрузки
  // страницы, в отличие от socket.emit. Мы НЕ удаляем участника мгновенно:
  // ставим короткое окно CLOSE_GRACE_MS, чтобы перезагрузка страницы или
  // случайный быстрый возврат успели отменить удаление через
  // rejoinProbe/joinRoom. Реальное закрытие вкладки/браузера — никто не
  // вернётся, и остальные увидят выход почти сразу (а не через полное
  // grace-окно, как при обычном обрыве сети). sendBeacon шлёт POST; мы читаем
  // peerId из query, тела нет — парсер не нужен.
  // ---------------------------------------------------------------------------
  app.post('/rooms/:roomId/leave', (req: Request, res: Response) => {
    const { roomId } = req.params
    const peerId = typeof req.query.peerId === 'string' ? req.query.peerId : ''
    if (!isValidRoomId(roomId) || !peerId) {
      res.status(204).end()
      return
    }
    markClosing(peerId)
    const timer = setTimeout(() => {
      evictPeer(io, roomId, peerId)
    }, CLOSE_GRACE_MS)
    scheduleEviction(peerId, timer)
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
