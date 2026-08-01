// ---------------------------------------------------------------------------
// Постоянное хранилище чата комнат (Postgres, тот же DATABASE_URL, что и у
// Next-приложения с авторизацией).
//
// Таблица `message` создаётся через drizzle-kit на стороне Next-приложения
// (`pnpm db:push`). Здесь мы работаем с ней напрямую через node-postgres с
// параметризованными запросами (защита от SQL-инъекций).
//
// Если DATABASE_URL не задан — модуль работает в режиме no-op: чат продолжает
// функционировать как раньше (эфемерно, без сохранения), сервер не падает.
// ---------------------------------------------------------------------------

import { Pool } from 'pg'

// Вложение сообщения (файл, лежащий на диске сервера). null-поля означают, что
// сообщение чисто текстовое.
export interface MessageAttachment {
  url: string // относительный путь: /uploads/<roomId>/<file>
  name: string // оригинальное имя файла
  size: number // размер в байтах
  mime: string // content-type
}

export interface StoredMessage {
  id: string
  roomId: string
  peerId: string
  displayName: string
  text: string
  timestamp: number
  attachment?: MessageAttachment | null
}

// Отметка "прочитано": до какого момента (timestamp, мс) участник прочитал чат.
export interface ReadMarker {
  peerId: string
  ts: number
}

const connectionString = process.env.DATABASE_URL

// Один пул на весь процесс. Создаётся только если есть строка подключения.
//
// Все таймауты заданы явно и это принципиально: по умолчанию в `pg`
// connectionTimeoutMillis = 0, то есть ожидание соединения бесконечно. Если база
// недоступна, перегружена или пул исчерпан, `await pool.query(...)` внутри
// обработчика joinRoom никогда не завершится — сервер не отправит ack, а клиент
// навсегда останется на экране «Подключение к комнате». Лучше быстро упасть с
// ошибкой (её ловит try/catch выше и комната открывается без истории чата),
// чем повиснуть.
const pool: Pool | null = connectionString
  ? new Pool({
      connectionString,
      // Ждём свободное соединение ограниченное время, а не вечно.
      connectionTimeoutMillis: 8_000,
      // Страховка на стороне сервера Postgres и на стороне клиента: одиночный
      // запрос не может держать обработчик дольше этого времени.
      statement_timeout: 10_000,
      query_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      max: 10,
      keepAlive: true,
    })
  : null

if (!pool) {
  console.warn(
    '[db] DATABASE_URL не задан — история чата сохраняться не будет (эфемерный режим).',
  )
} else {
  pool.on('error', (e) => {
    // Не роняем процесс из-за обрыва простаивающего соединения.
    console.error('[db] Ошибка пула Postgres:', e.message)
  })
}

export const isChatPersistenceEnabled = (): boolean => pool !== null

// Один пул на процесс. Личные чаты (server/src/dm/*) переиспользуют его же,
// чтобы не открывать второй набор соединений к той же базе.
export const dbPool = pool

/**
 * Сохранить сообщение. id генерируется клиентом/сервером заранее, чтобы
 * оптимистичная копия отправителя и сохранённая запись имели один и тот же id
 * (это исключает дубликаты при загрузке истории). Повторная вставка того же id
 * игнорируется.
 */
export async function saveMessage(msg: StoredMessage): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO "message" ("id", "roomId", "peerId", "displayName", "text", "attachment", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
       ON CONFLICT ("id") DO NOTHING`,
      [
        msg.id,
        msg.roomId,
        msg.peerId,
        msg.displayName,
        msg.text,
        msg.attachment ? JSON.stringify(msg.attachment) : null,
        msg.timestamp,
      ],
    )
  } catch (e) {
    console.error('[db] saveMessage failed:', (e as Error).message)
  }
}

/**
 * Получить историю сообщений комнаты (по возрастанию времени).
 * limit ограничивает выдачу самыми свежими сообщениями.
 */
export async function getRoomMessages(
  roomId: string,
  limit = 200,
): Promise<StoredMessage[]> {
  if (!pool) return []
  try {
    // Берём последние `limit` сообщений, затем разворачиваем в хронологический
    // порядок (старые сверху) для отображения в чате.
    const { rows } = await pool.query(
      `SELECT "id", "roomId", "peerId", "displayName", "text", "attachment",
              (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint AS "timestamp"
       FROM "message"
       WHERE "roomId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [roomId, limit],
    )
    return rows
      .map((r) => ({
        id: r.id as string,
        roomId: r.roomId as string,
        peerId: r.peerId as string,
        displayName: r.displayName as string,
        text: r.text as string,
        // pg возвращает jsonb уже распарсенным объектом (или null).
        attachment: (r.attachment as MessageAttachment | null) ?? null,
        timestamp: Number(r.timestamp),
      }))
      .reverse()
  } catch (e) {
    console.error('[db] getRoomMessages failed:', (e as Error).message)
    return []
  }
}

/**
 * Сохранить/обновить отметку "прочитано" участника. Храним максимум: время
 * никогда не откатывается назад (GREATEST), чтобы гонки сообщений не сбрасывали
 * прогресс прочтения. timestamp — мс, как у сообщений.
 */
export async function saveReadMarker(
  roomId: string,
  peerId: string,
  ts: number,
): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      `INSERT INTO "message_read" ("roomId", "peerId", "lastReadAt", "updatedAt")
       VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
       ON CONFLICT ("roomId", "peerId") DO UPDATE
         SET "lastReadAt" = GREATEST("message_read"."lastReadAt", EXCLUDED."lastReadAt"),
             "updatedAt" = now()`,
      [roomId, peerId, ts],
    )
  } catch (e) {
    console.error('[db] saveReadMarker failed:', (e as Error).message)
  }
}

/**
 * Получить отметки "прочитано" всех участников комнаты. Используется при входе,
 * чтобы сразу отрисовать галочки на уже отправленных сообщениях.
 */
export async function getRoomReadMarkers(roomId: string): Promise<ReadMarker[]> {
  if (!pool) return []
  try {
    const { rows } = await pool.query(
      `SELECT "peerId", (EXTRACT(EPOCH FROM "lastReadAt") * 1000)::bigint AS "ts"
       FROM "message_read"
       WHERE "roomId" = $1`,
      [roomId],
    )
    return rows.map((r) => ({ peerId: r.peerId as string, ts: Number(r.ts) }))
  } catch (e) {
    console.error('[db] getRoomReadMarkers failed:', (e as Error).message)
    return []
  }
}

/**
 * Удалить всю историю чата комнаты. Вызывается при уничтожении комнаты
 * (когда она опустела), чтобы чат стирался вместе с ней. Заодно стираем
 * отметки прочтения и доску — они привязаны к этой же комнате.
 */
export async function deleteRoomMessages(roomId: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(`DELETE FROM "message" WHERE "roomId" = $1`, [roomId])
    await pool.query(`DELETE FROM "message_read" WHERE "roomId" = $1`, [roomId])
    await pool.query(`DELETE FROM "whiteboard" WHERE "roomId" = $1`, [roomId])
    await pool.query(`DELETE FROM "presentation_drawing" WHERE "roomId" = $1`, [roomId])
    console.log(`[db] Удалена история чата комнаты ${roomId}`)
  } catch (e) {
    console.error('[db] deleteRoomMessages failed:', (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Совместная доска (tldraw)
// ---------------------------------------------------------------------------

export interface StoredWhiteboard {
  snapshot: string | null
  open: boolean
}

/**
 * Сохранить/обновить снапшот доски комнаты и/или флаг "открыта". Передавай
 * только те поля, которые меняются. Вызывае��ся дебаунсенно во время рисования,
 * поэтому пишем upsert одной строкой на комнату.
 */
export async function saveWhiteboard(
  roomId: string,
  fields: { snapshot?: string | null; open?: boolean },
): Promise<void> {
  if (!pool) return
  try {
    const hasSnapshot = Object.prototype.hasOwnProperty.call(fields, 'snapshot')
    const hasOpen = Object.prototype.hasOwnProperty.call(fields, 'open')
    await pool.query(
      `INSERT INTO "whiteboard" ("roomId", "snapshot", "open", "updatedAt")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("roomId") DO UPDATE SET
         "snapshot" = CASE WHEN $4 THEN EXCLUDED."snapshot" ELSE "whiteboard"."snapshot" END,
         "open"     = CASE WHEN $5 THEN EXCLUDED."open"     ELSE "whiteboard"."open"     END,
         "updatedAt" = now()`,
      [
        roomId,
        hasSnapshot ? fields.snapshot ?? null : null,
        hasOpen ? fields.open ?? false : false,
        hasSnapshot,
        hasOpen,
      ],
    )
  } catch (e) {
    console.error('[db] saveWhiteboard failed:', (e as Error).message)
  }
}

/** Получить снапшот и флаг "открыта" доски комнаты. */
export async function getWhiteboard(roomId: string): Promise<StoredWhiteboard> {
  if (!pool) return { snapshot: null, open: false }
  try {
    const { rows } = await pool.query(
      `SELECT "snapshot", "open" FROM "whiteboard" WHERE "roomId" = $1`,
      [roomId],
    )
    if (rows.length === 0) return { snapshot: null, open: false }
    return {
      snapshot: (rows[0].snapshot as string | null) ?? null,
      open: Boolean(rows[0].open),
    }
  } catch (e) {
    console.error('[db] getWhiteboard failed:', (e as Error).message)
    return { snapshot: null, open: false }
  }
}

// ---------------------------------------------------------------------------
// Рисунки поверх слайдов презентации
// ---------------------------------------------------------------------------

/**
 * Сохранить/обновить снапшот рисунка на слайде.
 * snapshot — data URL (base64 PNG) или null (стереть).
 * slideIndex — 0-based индекс слайда.
 */
export async function savePresentationDrawing(
  roomId: string,
  slideIndex: number,
  snapshot: string | null,
): Promise<void> {
  if (!pool) return
  // Ограничиваем размер во избежание переполнения БД (5 МБ на слайд).
  if (snapshot !== null && snapshot.length > 5_000_000) return
  try {
    await pool.query(
      `INSERT INTO "presentation_drawing" ("roomId", "slideIndex", "snapshot", "updatedAt")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("roomId", "slideIndex") DO UPDATE SET
         "snapshot" = EXCLUDED."snapshot",
         "updatedAt" = now()`,
      [roomId, String(slideIndex), snapshot],
    )
  } catch (e) {
    console.error('[db] savePresentationDrawing failed:', (e as Error).message)
  }
}

/**
 * Получить все рисунки комнаты: Map<slideIndex, snapshotDataURL>.
 * Вызывается при воссоздании комнаты (после рестарта сервера) и при входе
 * нового участника, чтобы он сразу увидел уже нарисованное.
 */
export async function getPresentationDrawings(
  roomId: string,
): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  if (!pool) return result
  try {
    const { rows } = await pool.query(
      `SELECT "slideIndex", "snapshot" FROM "presentation_drawing"
       WHERE "roomId" = $1 AND "snapshot" IS NOT NULL`,
      [roomId],
    )
    for (const r of rows) {
      result.set(Number(r.slideIndex), r.snapshot as string)
    }
  } catch (e) {
    console.error('[db] getPresentationDrawings failed:', (e as Error).message)
  }
  return result
}

/**
 * Удалить все рисунки комнаты. Вызывается при уничтожении комнаты.
 * (deleteRoomMessages уже вызывает это через отдельный запрос — дублируем
 * здесь для явности и для случаев, когда нужно удалить только рисунки.)
 */
export async function deletePresentationDrawings(roomId: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(
      `DELETE FROM "presentation_drawing" WHERE "roomId" = $1`,
      [roomId],
    )
  } catch (e) {
    console.error('[db] deletePresentationDrawings failed:', (e as Error).message)
  }
}
