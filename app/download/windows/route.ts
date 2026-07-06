import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import type { NextRequest } from 'next/server'

// Раздача Windows-установщика (.exe, ~900 МБ) с ТОГО ЖЕ origin, что и сайт.
//
// Почему здесь, а не только на mediasoup-сервере (порт 3001):
// в проде nginx проксирует на mediasoup только `/socket.io/`. Маршрут
// `/download/windows` попадает в `location /` → Next.js, поэтому если бы файл
// отдавал только Express, запрос до него не доходил бы и браузер показывал бы
// «Загрузка прервана». Отдаём файл прямо из Next — тогда работает с текущим
// nginx без изменений.
//
// Файл лежит на диске VPS и НЕ коммитится в git. Путь настраивается через
// WINDOWS_INSTALLER_PATH; по умолчанию — <cwd>/server/downloads/<name>.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INSTALLER_NAME =
  process.env.WINDOWS_INSTALLER_NAME ?? 'Replixo-Setup-version-1.exe'

const INSTALLER_PATH =
  process.env.WINDOWS_INSTALLER_PATH ??
  path.join(process.cwd(), 'server', 'downloads', INSTALLER_NAME)

function baseHeaders(size: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${INSTALLER_NAME}"`,
    // Разрешаем докачку/возобновление после обрыва.
    'Accept-Ranges': 'bytes',
    // Отключаем буферизацию nginx для этого ответа: без этого большой файл
    // буферизуется прокси во временный файл и на медленных соединениях
    // download «рвётся». Заголовок nginx уважает даже в `location /`.
    'X-Accel-Buffering': 'no',
    'Cache-Control': 'private, max-age=0, no-store',
    'Content-Length': String(size),
  }
}

export async function GET(req: NextRequest) {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(INSTALLER_PATH)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    console.error(`[download] Установщик не найден: ${INSTALLER_PATH}`)
    return new Response(
      JSON.stringify({ error: 'Установщик временно недоступен' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const total = stat.size
  const range = req.headers.get('range')

  // Range-запрос (докачка / возобновление после обрыва).
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match) {
      const startRaw = match[1]
      const endRaw = match[2]
      let start = startRaw ? parseInt(startRaw, 10) : 0
      let end = endRaw ? parseInt(endRaw, 10) : total - 1

      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end)) end = total - 1
      end = Math.min(end, total - 1)

      if (start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }

      const chunkSize = end - start + 1
      const nodeStream = fs.createReadStream(INSTALLER_PATH, { start, end })
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream

      return new Response(webStream, {
        status: 206,
        headers: {
          ...baseHeaders(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
      })
    }
  }

  // Полный файл.
  const nodeStream = fs.createReadStream(INSTALLER_PATH)
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream

  return new Response(webStream, {
    status: 200,
    headers: baseHeaders(total),
  })
}
