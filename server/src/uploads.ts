// ---------------------------------------------------------------------------
// Файловые вложения чата на диске VPS.
//
// Все файлы лежат под UPLOAD_DIR в подпапке на комнату:
//   <UPLOAD_DIR>/<roomId>/<uuid>.<ext>
//
// Жизненный цикл = жизненный цикл комнаты: папка комнаты удаляется целиком,
// когда комната опустела и уничтожается (socket.ts → cleanupRoomIfEmpty).
// Фоновый сборщик (sweepOrphanUploads) подчищает папки, осиротевшие после
// жёсткого падения процесса, чтобы диск не тёк.
// ---------------------------------------------------------------------------

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { UPLOAD_DIR, UPLOAD_TTL_MS } from './config'

// roomId приходит из URL — строго ограничиваем символы, чтобы исключить выход
// за пределы UPLOAD_DIR (path traversal вроде "../../etc").
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId)
}

/** Абсолютный путь к папке вложений конкретной комнаты. */
export function roomUploadDir(roomId: string): string {
  return path.join(UPLOAD_DIR, roomId)
}

/** Создать корневую папку загрузок, если её ещё нет. */
export function ensureUploadRoot(): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

/** Создать папку вложений комнаты (идемпотентно). */
export function ensureRoomDir(roomId: string): string {
  const dir = roomUploadDir(roomId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Удалить все вложения комнаты. Вызывается при уничтожении комнаты, чтобы файлы
 * стирались вместе с ней (без утечки места на диске). Fire-and-forget.
 */
export async function deleteRoomUploads(roomId: string): Promise<void> {
  if (!isValidRoomId(roomId)) return
  try {
    await fsp.rm(roomUploadDir(roomId), { recursive: true, force: true })
    console.log(`[uploads] Удалены вложения комнаты ${roomId}`)
  } catch (e) {
    console.error('[uploads] deleteRoomUploads failed:', (e as Error).message)
  }
}

/**
 * Подчистить осиротевшие папки: те, что не менялись дольше UPLOAD_TTL_MS.
 * Защита от утечки места на диске, если штатная очистка не отработала
 * (например, сервер был убит во время звонка). Активные комнаты не трогаются —
 * у них свежие файлы, mtime обновляется при каждой загрузке.
 */
export async function sweepOrphanUploads(): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true })
  } catch {
    return // папки ещё нет — чистить нечего
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(UPLOAD_DIR, entry.name)
    try {
      const stat = await fsp.stat(dir)
      if (now - stat.mtimeMs > UPLOAD_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true })
        console.log(`[uploads] Подчищена осиротевшая папка ${entry.name}`)
      }
    } catch {
      // Игнорируем — папку могли удалить параллельно.
    }
  }
}
