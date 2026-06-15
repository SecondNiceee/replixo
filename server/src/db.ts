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
 * Удалить всю историю чата комнаты. Вызывается при уничтожении комнаты
 * (когда она опустела), чтобы чат стирался вместе с ней.
 */
export async function deleteRoomMessages(roomId: string): Promise<void> {
  if (!pool) return
  try {
    await pool.query(`DELETE FROM "message" WHERE "roomId" = $1`, [roomId])
    console.log(`[db] Удалена история чата комнаты ${roomId}`)
  } catch (e) {
    console.error('[db] deleteRoomMessages failed:', (e as Error).message)
  }
}
