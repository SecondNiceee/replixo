// ---------------------------------------------------------------------------
// Постоянка личных чатов (ЛС). Таблицы dm_conversation / dm_conversation_member
// / dm_message создаются на стороне Next-приложения (drizzle-kit), здесь мы
// работаем с ними напрямую через node-postgres параметризованными запросами.
//
// Пул переиспользуется из ../db (один пул на процесс). Если DATABASE_URL не
// задан — пула нет, и namespace /dm просто не регистрируется: личный чат без
// постоянки бессмысленен (в отличие от эфемерного чата комнаты).
// ---------------------------------------------------------------------------

import { dbPool } from '../db'

export interface DmIdentity {
  userId: string
  name: string
  username: string | null
}

/** Вложение сообщения. Хранится в dm_message.attachment (jsonb). */
export interface DmAttachment {
  url: string
  name: string
  size: number
  mime: string
}

export interface InsertedMessage {
  createdAt: number // мс
  memberIds: string[]
  /** true, если сообщение с таким id уже существовало (идемпотентный ретрай). */
  duplicate: boolean
}

export const isDmEnabled = (): boolean => dbPool !== null

/**
 * Валидация сессии Better Auth напрямую в Postgres: сервер не имеет доступа к
 * секретам приложения, но таблица "session" — общая, и токен в ней уникален.
 */
export async function validateSessionToken(token: string): Promise<DmIdentity | null> {
  if (!dbPool) return null
  try {
    const { rows } = await dbPool.query(
      `SELECT s."userId", u."name", u."username"
       FROM "session" s
       JOIN "user" u ON u."id" = s."userId"
       WHERE s."token" = $1 AND s."expiresAt" > now()
       LIMIT 1`,
      [token],
    )
    if (rows.length === 0) return null
    return {
      userId: rows[0].userId as string,
      name: (rows[0].name as string) ?? '',
      username: (rows[0].username as string | null) ?? null,
    }
  } catch (e) {
    console.error('[dm] validateSessionToken failed:', (e as Error).message)
    return null
  }
}

/** Есть ли между пользователями принятая дружба (в любом направлении). */
export async function areFriends(a: string, b: string): Promise<boolean> {
  if (!dbPool) return false
  try {
    const { rows } = await dbPool.query(
      `SELECT 1 FROM "friendship"
       WHERE "status" = 'accepted'
         AND (("requesterId" = $1 AND "addresseeId" = $2)
           OR ("requesterId" = $2 AND "addresseeId" = $1))
       LIMIT 1`,
      [a, b],
    )
    return rows.length > 0
  } catch (e) {
    console.error('[dm] areFriends failed:', (e as Error).message)
    return false
  }
}

/** Все участники диалога (для адресации broadcast'ов). */
export async function listMemberIds(conversationId: string): Promise<string[]> {
  if (!dbPool) return []
  try {
    const { rows } = await dbPool.query(
      `SELECT "userId" FROM "dm_conversation_member" WHERE "conversationId" = $1`,
      [conversationId],
    )
    return rows.map((r) => r.userId as string)
  } catch (e) {
    console.error('[dm] listMemberIds failed:', (e as Error).message)
    return []
  }
}

/** Участник ли пользователь диалога. Дешёвая проверка для частых событий. */
export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  if (!dbPool) return false
  try {
    const { rows } = await dbPool.query(
      `SELECT 1 FROM "dm_conversation_member"
       WHERE "conversationId" = $1 AND "userId" = $2 LIMIT 1`,
      [conversationId, userId],
    )
    return rows.length > 0
  } catch (e) {
    console.error('[dm] isMember failed:', (e as Error).message)
    return false
  }
}

/** Id всех принятых друзей — адресаты событий presence. */
export async function listFriendIds(userId: string): Promise<string[]> {
  if (!dbPool) return []
  try {
    const { rows } = await dbPool.query(
      `SELECT CASE WHEN "requesterId" = $1 THEN "addresseeId" ELSE "requesterId" END AS "friendId"
       FROM "friendship"
       WHERE "status" = 'accepted' AND ("requesterId" = $1 OR "addresseeId" = $1)`,
      [userId],
    )
    return rows.map((r) => r.friendId as string)
  } catch (e) {
    console.error('[dm] listFriendIds failed:', (e as Error).message)
    return []
  }
}

/**
 * Отметить диалог прочитанным до момента ts: сдвинуть маркер и обнулить
 * счётчик непрочитанных. GREATEST не даёт маркеру уехать назад, если события
 * от разных устройств пришли не по порядку.
 *
 * null — пользователь не участник диалога (или ошибка БД).
 */
export async function markRead(
  conversationId: string,
  userId: string,
  ts: number,
): Promise<{ memberIds: string[]; ts: number } | null> {
  if (!dbPool) return null
  try {
    const { rows } = await dbPool.query(
      `UPDATE "dm_conversation_member"
       SET "lastReadAt" = GREATEST("lastReadAt", to_timestamp($3 / 1000.0)),
           "unreadCount" = 0
       WHERE "conversationId" = $1 AND "userId" = $2
       RETURNING (EXTRACT(EPOCH FROM "lastReadAt") * 1000)::bigint AS "ts"`,
      [conversationId, userId, ts],
    )
    if (rows.length === 0) return null
    const memberIds = await listMemberIds(conversationId)
    return { memberIds, ts: Number(rows[0].ts) }
  } catch (e) {
    console.error('[dm] markRead failed:', (e as Error).message)
    return null
  }
}

/**
 * Записать сообщение в одной транзакции:
 *   membership → INSERT сообщения → указатель последнего сообщения →
 *   инкремент непрочитанных у всех, кроме отправителя.
 *
 * Возвращает null, если отправитель не участник диалога (или ошибка БД).
 * Повторная отправка того же id не создаёт дубликат (ON CONFLICT DO NOTHING)
 * и возвращает время уже сохранённой записи.
 */
export async function insertMessage(msg: {
  id: string
  conversationId: string
  senderId: string
  text: string
  attachment?: DmAttachment | null
}): Promise<InsertedMessage | null> {
  if (!dbPool) return null
  const client = await dbPool.connect()
  try {
    await client.query('BEGIN')

    const membersRes = await client.query(
      `SELECT "userId" FROM "dm_conversation_member" WHERE "conversationId" = $1`,
      [msg.conversationId],
    )
    const memberIds = membersRes.rows.map((r) => r.userId as string)
    if (!memberIds.includes(msg.senderId)) {
      await client.query('ROLLBACK')
      return null
    }

    // attachment — jsonb: node-postgres сам сериализует объект, но null нужно
    // передать именно как null, а не как строку "null".
    const inserted = await client.query(
      `INSERT INTO "dm_message" ("id", "conversationId", "senderId", "text", "attachment", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT ("id") DO NOTHING
       RETURNING (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint AS "ts"`,
      [
        msg.id,
        msg.conversationId,
        msg.senderId,
        msg.text,
        msg.attachment ? JSON.stringify(msg.attachment) : null,
      ],
    )

    if (inserted.rows.length === 0) {
      // Такой id уже есть — это ретрай после реконнекта. Отдаём время
      // существующей записи, ничего не меняя.
      const existing = await client.query(
        `SELECT (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint AS "ts"
         FROM "dm_message" WHERE "id" = $1`,
        [msg.id],
      )
      await client.query('COMMIT')
      return {
        createdAt: existing.rows.length > 0 ? Number(existing.rows[0].ts) : Date.now(),
        memberIds,
        duplicate: true,
      }
    }

    const createdAt = Number(inserted.rows[0].ts)

    await client.query(
      `UPDATE "dm_conversation"
       SET "lastMessageId" = $1,
           "lastMessageAt" = to_timestamp($2 / 1000.0)
       WHERE "id" = $3`,
      [msg.id, createdAt, msg.conversationId],
    )

    await client.query(
      `UPDATE "dm_conversation_member"
       SET "unreadCount" = "unreadCount" + 1
       WHERE "conversationId" = $1 AND "userId" <> $2`,
      [msg.conversationId, msg.senderId],
    )

    await client.query('COMMIT')
    return { createdAt, memberIds, duplicate: false }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[dm] insertMessage failed:', (e as Error).message)
    return null
  } finally {
    client.release()
  }
}
