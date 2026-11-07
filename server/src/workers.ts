import * as mediasoup from 'mediasoup'
import type { Worker } from 'mediasoup/types'
import { MEDIASOUP_WORKERS, workerSettings, webRtcServerOptionsFor } from './config'

// ---------------------------------------------------------------------------
// mediasoup worker pool. A worker is a single-threaded C++ process, so one
// worker can only ever use one CPU core. New rooms go to the least loaded
// worker; a room stays on its worker for its whole lifetime.
// ---------------------------------------------------------------------------

interface PoolEntry {
  worker: Worker
  rooms: number
}

const pool: PoolEntry[] = []

export async function startWorkers(): Promise<void> {
  for (let index = 0; index < MEDIASOUP_WORKERS; index++) {
    const worker = await mediasoup.createWorker(workerSettings)

    worker.on('died', (error) => {
      console.error(`[mediasoup] Worker ${worker.pid} died, exiting in 2 seconds...`, error)
      setTimeout(() => process.exit(1), 2000)
    })

    const serverOptions = webRtcServerOptionsFor(index)
    if (serverOptions) {
      worker.appData.webRtcServer = await worker.createWebRtcServer(serverOptions)
      console.log(`[mediasoup] Worker ${worker.pid}: WebRtcServer on port ${serverOptions.listenInfos[0].port} (udp+tcp)`)
    }

    pool.push({ worker, rooms: 0 })
    console.log(`[mediasoup] Worker created (pid: ${worker.pid}, ${index + 1}/${MEDIASOUP_WORKERS})`)
  }
}

export function acquireWorker(): Worker {
  if (pool.length === 0) throw new Error('mediasoup workers are not started')
  let best = pool[0]
  for (const entry of pool) {
    if (entry.rooms < best.rooms) best = entry
  }
  best.rooms++
  return best.worker
}

export function releaseWorker(worker: Worker): void {
  const entry = pool.find((candidate) => candidate.worker === worker)
  if (entry) entry.rooms = Math.max(0, entry.rooms - 1)
}

export function closeWorkers(): void {
  for (const { worker } of pool) worker.close()
}
