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

export interface StoredMessage {
  id: string
  roomId: string
  peerId: string
  displayName: string
  text: string
  timestamp: number
}

// Отметка "прочитано": до какого момента (timestamp, мс) участник прочитал чат.
export interface ReadMarker {
  peerId: string
  ts: number
}

const connectionString = process.env.DATABASE_URL

// Один пул на весь процесс. Создаётся только если есть строка подключения.
const pool: Pool | null = connectionString
  ? new Pool({ connectionString })
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
      `INSERT INTO "message" ("id", "roomId", "peerId", "displayName", "text", "createdAt")
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
       ON CONFLICT ("id") DO NOTHING`,
      [msg.id, msg.roomId, msg.peerId, msg.displayName, msg.text, msg.timestamp],
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
      `SELECT "id", "roomId", "peerId", "displayName", "text",
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
 * только те поля, которые меняются. Вызывается дебаунсенно во время рисования,
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
