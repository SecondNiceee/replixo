"use strict";
// ---------------------------------------------------------------------------
// Постоянка личных чатов (ЛС). Таблицы dm_conversation / dm_conversation_member
// / dm_message создаются на стороне Next-приложения (drizzle-kit), здесь мы
// работаем с ними напрямую через node-postgres параметризованными запросами.
//
// Пул переиспользуется из ../db (один пул на процесс). Если DATABASE_URL не
// задан — пула нет, и namespace /dm просто не регистрируется: личный чат без
// постоянки бессмысленен (в отличие от эфемерного чата комнаты).
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDmEnabled = void 0;
exports.validateSessionToken = validateSessionToken;
exports.areFriends = areFriends;
exports.listMemberIds = listMemberIds;
exports.isMember = isMember;
exports.listFriendIds = listFriendIds;
exports.markRead = markRead;
exports.insertMessage = insertMessage;
const db_1 = require("../db");
const isDmEnabled = () => db_1.dbPool !== null;
exports.isDmEnabled = isDmEnabled;
/**
 * Валидация сессии Better Auth напрямую в Postgres: сервер не имеет доступа к
 * секретам приложения, но таблица "session" — общая, и токен в ней уникален.
 */
async function validateSessionToken(token) {
    if (!db_1.dbPool)
        return null;
    try {
        const { rows } = await db_1.dbPool.query(`SELECT s."userId", u."name", u."username"
       FROM "session" s
       JOIN "user" u ON u."id" = s."userId"
       WHERE s."token" = $1 AND s."expiresAt" > now()
       LIMIT 1`, [token]);
        if (rows.length === 0)
            return null;
        return {
            userId: rows[0].userId,
            name: rows[0].name ?? '',
            username: rows[0].username ?? null,
        };
    }
    catch (e) {
        console.error('[dm] validateSessionToken failed:', e.message);
        return null;
    }
}
/** Есть ли между пользователями принятая дружба (в любом направлении). */
async function areFriends(a, b) {
    if (!db_1.dbPool)
        return false;
    try {
        const { rows } = await db_1.dbPool.query(`SELECT 1 FROM "friendship"
       WHERE "status" = 'accepted'
         AND (("requesterId" = $1 AND "addresseeId" = $2)
           OR ("requesterId" = $2 AND "addresseeId" = $1))
       LIMIT 1`, [a, b]);
        return rows.length > 0;
    }
    catch (e) {
        console.error('[dm] areFriends failed:', e.message);
        return false;
    }
}
/** Все участники диалога (для адресации broadcast'ов). */
async function listMemberIds(conversationId) {
    if (!db_1.dbPool)
        return [];
    try {
        const { rows } = await db_1.dbPool.query(`SELECT "userId" FROM "dm_conversation_member" WHERE "conversationId" = $1`, [conversationId]);
        return rows.map((r) => r.userId);
    }
    catch (e) {
        console.error('[dm] listMemberIds failed:', e.message);
        return [];
    }
}
/** Участник ли пользователь диалога. Дешёвая проверка для частых событий. */
async function isMember(conversationId, userId) {
    if (!db_1.dbPool)
        return false;
    try {
        const { rows } = await db_1.dbPool.query(`SELECT 1 FROM "dm_conversation_member"
       WHERE "conversationId" = $1 AND "userId" = $2 LIMIT 1`, [conversationId, userId]);
        return rows.length > 0;
    }
    catch (e) {
        console.error('[dm] isMember failed:', e.message);
        return false;
    }
}
/** Id всех принятых друзей — адресаты событий presence. */
async function listFriendIds(userId) {
    if (!db_1.dbPool)
        return [];
    try {
        const { rows } = await db_1.dbPool.query(`SELECT CASE WHEN "requesterId" = $1 THEN "addresseeId" ELSE "requesterId" END AS "friendId"
       FROM "friendship"
       WHERE "status" = 'accepted' AND ("requesterId" = $1 OR "addresseeId" = $1)`, [userId]);
        return rows.map((r) => r.friendId);
    }
    catch (e) {
        console.error('[dm] listFriendIds failed:', e.message);
        return [];
    }
}
/**
 * Отметить диалог прочитанным до момента ts: сдвинуть маркер и обнулить
 * счётчик непрочитанных. GREATEST не даёт маркеру уехать назад, если события
 * от разных устройств пришли не по порядку.
 *
 * null — пользователь не участник диалога (или ошибка БД).
 */
async function markRead(conversationId, userId, ts) {
    if (!db_1.dbPool)
        return null;
    try {
        const { rows } = await db_1.dbPool.query(`UPDATE "dm_conversation_member"
       SET "lastReadAt" = GREATEST("lastReadAt", to_timestamp($3 / 1000.0)),
           "unreadCount" = 0
       WHERE "conversationId" = $1 AND "userId" = $2
       RETURNING (EXTRACT(EPOCH FROM "lastReadAt") * 1000)::bigint AS "ts"`, [conversationId, userId, ts]);
        if (rows.length === 0)
            return null;
        const memberIds = await listMemberIds(conversationId);
        return { memberIds, ts: Number(rows[0].ts) };
    }
    catch (e) {
        console.error('[dm] markRead failed:', e.message);
        return null;
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
async function insertMessage(msg) {
    if (!db_1.dbPool)
        return null;
    const client = await db_1.dbPool.connect();
    try {
        await client.query('BEGIN');
        const membersRes = await client.query(`SELECT "userId" FROM "dm_conversation_member" WHERE "conversationId" = $1`, [msg.conversationId]);
        const memberIds = membersRes.rows.map((r) => r.userId);
        if (!memberIds.includes(msg.senderId)) {
            await client.query('ROLLBACK');
            return null;
        }
        // attachment — jsonb: node-postgres сам сериализует объект, но null нужно
        // передать именно как null, а не как строку "null".
        const inserted = await client.query(`INSERT INTO "dm_message" ("id", "conversationId", "senderId", "text", "attachment", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT ("id") DO NOTHING
       RETURNING (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint AS "ts"`, [
            msg.id,
            msg.conversationId,
            msg.senderId,
            msg.text,
            msg.attachment ? JSON.stringify(msg.attachment) : null,
        ]);
        if (inserted.rows.length === 0) {
            // Такой id уже есть — это ретрай после реконнекта. Отдаём время
            // существующей записи, ничего не меняя.
            const existing = await client.query(`SELECT (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint AS "ts"
         FROM "dm_message" WHERE "id" = $1`, [msg.id]);
            await client.query('COMMIT');
            return {
                createdAt: existing.rows.length > 0 ? Number(existing.rows[0].ts) : Date.now(),
                memberIds,
                duplicate: true,
            };
        }
        const createdAt = Number(inserted.rows[0].ts);
        await client.query(`UPDATE "dm_conversation"
       SET "lastMessageId" = $1,
           "lastMessageAt" = to_timestamp($2 / 1000.0)
       WHERE "id" = $3`, [msg.id, createdAt, msg.conversationId]);
        await client.query(`UPDATE "dm_conversation_member"
       SET "unreadCount" = "unreadCount" + 1
       WHERE "conversationId" = $1 AND "userId" <> $2`, [msg.conversationId, msg.senderId]);
        await client.query('COMMIT');
        return { createdAt, memberIds, duplicate: false };
    }
    catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error('[dm] insertMessage failed:', e.message);
        return null;
    }
    finally {
        client.release();
    }
}
