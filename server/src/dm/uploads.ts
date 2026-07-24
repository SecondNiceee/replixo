// ---------------------------------------------------------------------------
// Вложения личных чатов на диске VPS.
//
//   <UPLOAD_DIR>/dm/<conversationId>/<uuid><ext>
//
// Ключевое отличие от вложений комнаты: история ЛС постоянна, поэтому эти файлы
// живут столько же, сколько сообщения. Здесь НЕТ ни удаления по событию, ни
// TTL-сборщика — sweepOrphanUploads явно пропускает папку dm/ (см. ../uploads).
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { DM_UPLOAD_SUBDIR, UPLOAD_DIR } from '../config'

// conversationId приходит из URL. Детерминированный id диалога выглядит как
// `direct:<userId>:<userId>`, поэтому двоеточие разрешено. Точка запрещена —
// это отсекает path traversal («..») на уровне формата, до любых join'ов.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/

export function isValidConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value)
}

/** Корень вложений ЛС: <UPLOAD_DIR>/dm. */
export function dmUploadRoot(): string {
  return path.join(UPLOAD_DIR, DM_UPLOAD_SUBDIR)
}

/** Абсолютный путь к папке вложений конкретного диалога. */
export function dmConversationDir(conversationId: string): string {
  return path.join(dmUploadRoot(), conversationId)
}

/** Создать папку вложений диалога (идемпотентно). */
export function ensureDmConversationDir(conversationId: string): string {
  const dir = dmConversationDir(conversationId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Публичный префикс, под которым файлы диалога раздаёт express.static. */
export function dmUrlPrefix(conversationId: string): string {
  return `/uploads/${DM_UPLOAD_SUBDIR}/${conversationId}/`
}

/**
 * Проверка, что ссылка на вложение указывает строго в папку ЭТОГО диалога.
 * Без неё клиент мог бы прислать в dm:send url на чужую переписку и получить
 * чужой файл, отрисованный как своё вложение.
 */
export function isDmAttachmentUrl(url: string, conversationId: string): boolean {
  return url.startsWith(dmUrlPrefix(conversationId)) && !url.includes('..')
}

// ---------------------------------------------------------------------------
// Rate limit загрузок: 20 файлов в минуту на пользователя.
//
// Считаем по userId, а не по сокету: у одного пользователя может быть несколько
// вкладок, и лимит должен быть общим. Загрузка идёт обычным HTTP-запросом, так
// что createRateLimiter (он рассчитан на одно соединение) здесь не подходит.
// ---------------------------------------------------------------------------

const UPLOAD_LIMIT = 20
const UPLOAD_WINDOW_MS = 60_000

const uploadHits = new Map<string, number[]>()

export function allowDmUpload(userId: string): boolean {
  const now = Date.now()
  const fresh = (uploadHits.get(userId) ?? []).filter(
    (ts) => now - ts < UPLOAD_WINDOW_MS,
  )
  if (fresh.length >= UPLOAD_LIMIT) {
    // Записываем обрезанное окно, чтобы память не росла на отказах.
    uploadHits.set(userId, fresh)
    return false
  }
  fresh.push(now)
  uploadHits.set(userId, fresh)
  return true
}

// Периодически выбрасываем пользователей, которые давно ничего не загружали:
// иначе Map жила бы вечно и текла на длинной аптайм-сессии сервера.
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const [userId, hits] of uploadHits) {
    if (hits.every((ts) => now - ts >= UPLOAD_WINDOW_MS)) uploadHits.delete(userId)
  }
}, UPLOAD_WINDOW_MS)
cleanupTimer.unref()
