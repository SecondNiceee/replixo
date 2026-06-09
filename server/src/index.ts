import 'dotenv/config'
import http from 'http'
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import * as mediasoup from 'mediasoup'
import { PORT, CLIENT_ORIGIN, workerSettings } from './config'
import { setupSocketIO } from './socket'

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
  setupSocketIO(httpServer, worker)

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  httpServer.listen(PORT, () => {
    console.log(`[server] Riplexo mediasoup server running on port ${PORT}`)
    console.log(`[server] CORS allowed origin: ${CLIENT_ORIGIN}`)
  })

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = (): void => {
    console.log('[server] Shutting down...')
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
