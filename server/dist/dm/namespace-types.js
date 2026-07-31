"use strict";
// Общие типы и мелкие помощники личного чата.
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRoom = userRoom;
exports.otherUserIdFrom = otherUserIdFrom;
/**
 * Socket.io-комната всех соединений одного пользователя. Так сообщение
 * доставляется на все его устройства/вкладки, даже когда чат закрыт.
 */
function userRoom(userId) {
    return `user:${userId}`;
}
/**
 * Второй участник диалога из детерминированного id `direct:<minId>:<maxId>`.
 * null — это не 1:1 диалог или пользователь в нём не участвует (тогда доступ
 * всё равно отсечёт membership-проверка в БД).
 *
 * Дублирует lib/chat/conversation-id.ts намеренно: сервер собирается
 * отдельным tsconfig и не импортирует код Next-приложения.
 */
function otherUserIdFrom(conversationId, selfId) {
    if (!conversationId.startsWith('direct:'))
        return null;
    const parts = conversationId.split(':');
    if (parts.length !== 3)
        return null;
    const [, a, b] = parts;
    if (a === selfId)
        return b;
    if (b === selfId)
        return a;
    return null;
}
