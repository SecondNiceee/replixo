"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDmHandlers = registerDmHandlers;
const helpers_1 = require("../socket/helpers");
const db_1 = require("./db");
const namespace_types_1 = require("./namespace-types");
const uploads_1 = require("./uploads");
// ---------------------------------------------------------------------------
// События личного чата. Авторство берётся ТОЛЬКО из socket.data.userId,
// который выставлен auth-middleware по токену сессии. Ничего из payload,
// касающегося личности отправителя, не используется.
// ---------------------------------------------------------------------------
const MAX_TEXT_LENGTH = 4000;
const MAX_ID_LENGTH = 64;
const MAX_CONVERSATION_ID_LENGTH = 128;
function respond(cb, payload) {
    if (typeof cb === 'function')
        cb(payload);
}
const MAX_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 128;
function isConversationId(value) {
    return typeof value === 'string' && !!value && value.length <= MAX_CONVERSATION_ID_LENGTH;
}
/**
 * Разбор вложения из payload.
 *
 * `undefined` — вложения нет (это нормально).
 * `null`      — вложение прислали, но оно невалидное → сообщение отбрасываем.
 *
 * Главная проверка — url указывает строго в папку ЭТОГО диалога. Файл уже лежит
 * на диске (его загрузил авторизованный POST /dm/:id/upload), поэтому без этой
 * привязки клиент мог бы подставить ссылку на вложение чужой переписки.
 */
function parseAttachment(raw, conversationId) {
    if (raw == null)
        return undefined;
    if (typeof raw !== 'object')
        return null;
    const { url, name, size, mime } = raw;
    if (typeof url !== 'string' || !(0, uploads_1.isDmAttachmentUrl)(url, conversationId))
        return null;
    if (typeof name !== 'string' || !name)
        return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0)
        return null;
    if (typeof mime !== 'string' || !mime)
        return null;
    return {
        url,
        name: name.slice(0, MAX_NAME_LENGTH),
        size,
        mime: mime.slice(0, MAX_MIME_LENGTH),
    };
}
function registerDmHandlers(nsp, socket) {
    const data = socket.data;
    // Скользящее окно: 10 сообщений за 2 секунды на соединение.
    const allowSend = (0, helpers_1.createRateLimiter)(10, 2000);
    // Служебные события (read/typing) летят чаще, но и стоят дешевле.
    const allowMeta = (0, helpers_1.createRateLimiter)(40, 2000);
    // Membership меняется только в сторону «стал участником», поэтому
    // положительный ответ можно кэшировать на время жизни соединения и не
    // ходить в БД на каждое нажатие клавиши.
    const confirmedMembership = new Set();
    const ensureMember = async (conversationId, userId) => {
        if (confirmedMembership.has(conversationId))
            return true;
        const ok = await (0, db_1.isMember)(conversationId, userId);
        if (ok)
            confirmedMembership.add(conversationId);
        return ok;
    };
    socket.on('dm:send', async (payload, cb) => {
        const senderId = data.userId;
        if (!senderId) {
            respond(cb, { ok: false, error: 'unauthorized' });
            socket.disconnect(true);
            return;
        }
        if (!payload || typeof payload !== 'object') {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        const { conversationId, id, text, attachment } = payload;
        if (typeof conversationId !== 'string' ||
            !conversationId ||
            conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        if (typeof text !== 'string') {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        const safeAttachment = parseAttachment(attachment, conversationId);
        if (safeAttachment === null) {
            respond(cb, { ok: false, error: 'bad_attachment' });
            return;
        }
        const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
        // Сообщение должно нести хоть что-то: текст или вложение. Файл без подписи
        // — обычный случай, поэтому пустой текст сам по себе не ошибка.
        if (!trimmed && !safeAttachment) {
            respond(cb, { ok: false, error: 'empty' });
            return;
        }
        if (!allowSend()) {
            respond(cb, { ok: false, error: 'rate_limited' });
            return;
        }
        // Для 1:1 писать можно только принятому другу. Историю читать после
        // удаления дружбы всё ещё можно, а писать — нет.
        const peerId = (0, namespace_types_1.otherUserIdFrom)(conversationId, senderId);
        if (peerId) {
            const friends = await (0, db_1.areFriends)(senderId, peerId);
            if (!friends) {
                respond(cb, { ok: false, error: 'not_friends' });
                return;
            }
        }
        // Membership проверяется внутри транзакции: null = не участник.
        const stored = await (0, db_1.insertMessage)({
            id,
            conversationId,
            senderId,
            text: trimmed,
            attachment: safeAttachment ?? null,
        });
        if (!stored) {
            respond(cb, { ok: false, error: 'not_member' });
            return;
        }
        respond(cb, { ok: true, id, createdAt: stored.createdAt });
        // Повторную отправку не рассылаем второй раз — получатели её уже видели.
        if (stored.duplicate)
            return;
        const message = {
            id,
            senderId,
            senderName: data.name ?? '',
            text: trimmed,
            attachment: safeAttachment ?? null,
            createdAt: stored.createdAt,
        };
        // Доставляем во все устройства всех участников (включая отправителя —
        // так вторая вкладка тоже увидит сообщение; дубли гасит дедуп по id).
        for (const memberId of stored.memberIds) {
            nsp.to((0, namespace_types_1.userRoom)(memberId)).emit('dm:message', { conversationId, message });
        }
    });
    // --- Прочитано --------------------------------------------------------
    // Рассылаем ВСЕМ участникам, включая самого читателя: его другие устройства
    // должны погасить счётчик непрочитанных синхронно.
    socket.on('dm:read', async (payload) => {
        const userId = data.userId;
        if (!userId || !allowMeta())
            return;
        const { conversationId, ts } = (payload ?? {});
        if (!isConversationId(conversationId))
            return;
        // Метку времени берём из payload, но не даём уехать в будущее: иначе
        // клиент мог бы «прочитать» сообщения, которых ещё нет.
        const now = Date.now();
        const at = typeof ts === 'number' && Number.isFinite(ts) ? Math.min(ts, now) : now;
        const res = await (0, db_1.markRead)(conversationId, userId, at);
        if (!res)
            return; // не участник — молча игнорируем
        for (const memberId of res.memberIds) {
            nsp.to((0, namespace_types_1.userRoom)(memberId)).emit('dm:read', { conversationId, userId, ts: res.ts });
        }
    });
    // --- «Печатает…» ------------------------------------------------------
    // Событие эфемерное: в БД не пишется, автосброс — на стороне клиента.
    socket.on('dm:typing', async (payload) => {
        const userId = data.userId;
        if (!userId || !allowMeta())
            return;
        const { conversationId, typing } = (payload ?? {});
        if (!isConversationId(conversationId) || typeof typing !== 'boolean')
            return;
        if (!(await ensureMember(conversationId, userId)))
            return;
        // Себе не отправляем: индикатор нужен только собеседнику.
        for (const memberId of await (0, db_1.listMemberIds)(conversationId)) {
            if (memberId === userId)
                continue;
            nsp.to((0, namespace_types_1.userRoom)(memberId)).emit('dm:typing', { conversationId, userId, typing });
        }
    });
}
