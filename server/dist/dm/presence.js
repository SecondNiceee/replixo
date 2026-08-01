"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOnline = isOnline;
exports.invalidateFriendsCache = invalidateFriendsCache;
exports.announceMutualPresence = announceMutualPresence;
exports.trackConnect = trackConnect;
exports.trackDisconnect = trackDisconnect;
const db_1 = require("./db");
const namespace_types_1 = require("./namespace-types");
// ---------------------------------------------------------------------------
// Presence личного чата: кто сейчас онлайн.
//
// Состояние — in-memory, потому что сервер один процесс (как и реестр комнат
// в socket/rooms). Для нескольких инстансов понадобится Redis-адаптер
// Socket.IO — отмечено в плане как задел на будущее.
//
// Ключевая деталь: у одного пользователя может быть несколько соединений
// (вкладки, телефон). Онлайн он ровно до тех пор, пока жив хотя бы один
// сокет, поэтому храним МНОЖЕСТВО socketId, а события online/offline
// отправляем только на переходах 0 → 1 и 1 → 0. Иначе закрытие второй
// вкладки гасило бы точку у собеседника.
// ---------------------------------------------------------------------------
/** userId → его живые socketId. */
const connections = new Map();
/** userId → когда пользователь ушёл в оффлайн (мс). */
const lastSeen = new Map();
/** Кэш списка друзей: адресатов presence спрашиваем часто, меняются они редко. */
const FRIENDS_TTL_MS = 30000;
const friendsCache = new Map();
async function friendsOf(userId) {
    const cached = friendsCache.get(userId);
    const now = Date.now();
    if (cached && now - cached.at < FRIENDS_TTL_MS)
        return cached.ids;
    const ids = await (0, db_1.listFriendIds)(userId);
    friendsCache.set(userId, { ids, at: now });
    return ids;
}
function isOnline(userId) {
    return (connections.get(userId)?.size ?? 0) > 0;
}
/**
 * Сбросить кэш друзей пользователя. Нужен, когда состав друзей изменился
 * (приняли заявку, удалили из друзей): иначе до FRIENDS_TTL_MS новый друг не
 * получал бы событий online/offline, а удалённый продолжал бы их получать.
 */
function invalidateFriendsCache(userId) {
    friendsCache.delete(userId);
}
/**
 * Взаимно объявить presence двум пользователям. Вызывается сразу после
 * подтверждения дружбы: снапшот они получили при подключении, когда друзьями
 * ещё не были, поэтому иначе точка «в сети» появилась бы только после reload.
 */
function announceMutualPresence(nsp, a, b) {
    if (isOnline(b))
        nsp.to((0, namespace_types_1.userRoom)(a)).emit('dm:presence', { userId: b, online: true });
    if (isOnline(a))
        nsp.to((0, namespace_types_1.userRoom)(b)).emit('dm:presence', { userId: a, online: true });
}
/**
 * Регистрирует соединение. Если оно первое у пользователя — рассылает друзьям
 * `dm:presence {online:true}`. Затем отдаёт этому сокету снапшот: какие из его
 * друзей онлайн и когда остальных видели последний раз.
 */
async function trackConnect(nsp, socket, userId) {
    let sockets = connections.get(userId);
    const isFirst = !sockets || sockets.size === 0;
    if (!sockets) {
        sockets = new Set();
        connections.set(userId, sockets);
    }
    sockets.add(socket.id);
    const friends = await friendsOf(userId);
    if (isFirst) {
        lastSeen.delete(userId);
        for (const friendId of friends) {
            nsp.to((0, namespace_types_1.userRoom)(friendId)).emit('dm:presence', { userId, online: true });
        }
    }
    const onlineUserIds = friends.filter(isOnline);
    const lastSeenAt = {};
    for (const friendId of friends) {
        const seen = lastSeen.get(friendId);
        if (seen !== undefined)
            lastSeenAt[friendId] = seen;
    }
    socket.emit('dm:presence:snapshot', { onlineUserIds, lastSeenAt });
}
/**
 * Снимает соединение с учёта. Оффлайн объявляем только когда у пользователя
 * не осталось ни одного сокета.
 */
async function trackDisconnect(nsp, socket, userId) {
    const sockets = connections.get(userId);
    if (!sockets)
        return;
    sockets.delete(socket.id);
    if (sockets.size > 0)
        return;
    connections.delete(userId);
    const at = Date.now();
    lastSeen.set(userId, at);
    const friends = await friendsOf(userId);
    for (const friendId of friends) {
        nsp.to((0, namespace_types_1.userRoom)(friendId)).emit('dm:presence', {
            userId,
            online: false,
            lastSeenAt: at,
        });
    }
}
