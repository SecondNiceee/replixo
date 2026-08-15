"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOnline = isOnline;
exports.statusOf = statusOf;
exports.statusesFor = statusesFor;
exports.invalidateFriendsCache = invalidateFriendsCache;
exports.announceMutualPresence = announceMutualPresence;
exports.trackConnect = trackConnect;
exports.trackPing = trackPing;
exports.setSocketStatus = setSocketStatus;
exports.broadcastCurrentStatus = broadcastCurrentStatus;
exports.trackDisconnect = trackDisconnect;
exports.startPresenceSweeper = startPresenceSweeper;
const db_1 = require("./db");
const namespace_types_1 = require("./namespace-types");
/** userId → (socketId → состояние этого соединения). */
const connections = new Map();
/**
 * Отложенное объявление оффлайна: userId → таймер.
 *
 * Перезагрузка страницы и мигнувшая сеть рвут websocket так же, как настоящий
 * уход, поэтому мгновенный оффлайн давал бы мигание точки у собеседника на
 * каждый F5. Grace-окно (по образцу RECONNECT_GRACE_MS в call-handlers) ждёт
 * возможного возврата. Важно: в lastSeenAt пишется момент РАЗРЫВА, а не момент
 * истечения таймера — иначе «был(а) только что» отставало бы на grace.
 */
const offlineTimers = new Map();
const OFFLINE_GRACE_MS = 8000;
/**
 * Как часто пишем lastSeenAt, пока пользователь онлайн.
 *
 * Это страховка от жёсткого падения процесса (kill -9, OOM): при штатном
 * разрыве время пишет trackDisconnect, но если процесс умрёт мгновенно, без
 * периодического сброса времени не осталось бы вовсе. 60 секунд — потолок
 * погрешности «был(а) N минут назад», незаметный в UI, но и не создающий
 * заметной нагрузки на БД (один UPDATE по первичному ключу на пользователя).
 */
const LAST_SEEN_FLUSH_MS = 60000;
/** userId → когда последний раз сбрасывали lastSeenAt в БД (throttle). */
const lastFlushAt = new Map();
/**
 * Порог живости прикладного heartbeat.
 *
 * Зачем он вообще, если у Socket.IO есть свой ping: pingTimeout у движка — 30
 * секунд (socket.ts), и понижать его нельзя, на нём держится устойчивость
 * звонков к мигнувшей сети. Поэтому у presence свой, более чуткий таймер:
 * клиент шлёт `dm:ping` каждые PING_INTERVAL_MS, а свипер считает соединение
 * мёртвым для presence через PING_TIMEOUT_MS тишины. Сам сокет при этом НЕ
 * рвём — им распоряжается движок и звонки.
 *
 * Порог с запасом больше интервала: один потерянный пинг на плохой сети не
 * должен гасить точку.
 */
const PING_TIMEOUT_MS = 15000;
const SWEEP_INTERVAL_MS = 5000;
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
/**
 * Есть ли у пользователя хотя бы одно живое соединение.
 *
 * Сознательно НЕ различает online и idle: этим предикатом пользуются звонки
 * (call-handlers), а отошедший от клавиатуры человек в звонке — всё ещё в
 * звонке. Для отображения статуса есть statusOf.
 */
function isOnline(userId) {
    return (connections.get(userId)?.size ?? 0) > 0;
}
/**
 * Сводный статус пользователя: online, если активна хотя бы одна вкладка; idle,
 * если все видимые вкладки отметились отошедшими; offline, если все вкладки в
 * фоне (или их нет вовсе).
 *
 * Вкладки в фоне не участвуют в подсчёте намеренно: иначе открытая в соседнем
 * табе страница Riplexo держала бы зелёную точку неделями.
 */
function statusOf(userId) {
    const sockets = connections.get(userId);
    if (!sockets || sockets.size === 0)
        return 'offline';
    let idle = false;
    for (const presence of sockets.values()) {
        if (presence.status === 'online')
            return 'online';
        if (presence.status === 'idle')
            idle = true;
    }
    return idle ? 'idle' : 'offline';
}
/** Статусы сразу для списка пользователей — для снапшота и /internal/presence. */
function statusesFor(userIds) {
    const result = {};
    for (const id of userIds) {
        const status = statusOf(id);
        // Оффлайн не передаём: это состояние по умолчанию, а пустые поля дешевле
        // и на проводе, и при слиянии на клиенте.
        if (status !== 'offline')
            result[id] = status;
    }
    return result;
}
/**
 * Сбросить кэш друзей пользователя. Нужен, когда состав друзей изменился
 * (приняли заявку, удалили из друзей): иначе до FRIENDS_TTL_MS новый друг не
 * получал бы событий presence, а удалённый продолжал бы их получать.
 */
function invalidateFriendsCache(userId) {
    friendsCache.delete(userId);
}
/** Разослать статус пользователя всем его друзьям. */
async function broadcastStatus(nsp, userId, status, lastSeenAt) {
    const friends = await friendsOf(userId);
    for (const friendId of friends) {
        nsp.to((0, namespace_types_1.userRoom)(friendId)).emit('dm:presence', { userId, status, lastSeenAt });
    }
}
/**
 * Взаимно объявить presence двум пользователям. Вызывается сразу после
 * подтверждения дружбы: снапшот они получили при подключении, когда друзьями
 * ещё не были, поэтому иначе точка «в сети» появилась бы только после reload.
 */
function announceMutualPresence(nsp, a, b) {
    const statusA = statusOf(a);
    const statusB = statusOf(b);
    if (statusB !== 'offline')
        nsp.to((0, namespace_types_1.userRoom)(a)).emit('dm:presence', { userId: b, status: statusB });
    if (statusA !== 'offline')
        nsp.to((0, namespace_types_1.userRoom)(b)).emit('dm:presence', { userId: a, status: statusA });
}
/** Записать lastSeenAt, но не чаще LAST_SEEN_FLUSH_MS (кроме force). */
function flushLastSeen(userId, at, force = false) {
    if (!force && at - (lastFlushAt.get(userId) ?? 0) < LAST_SEEN_FLUSH_MS)
        return;
    lastFlushAt.set(userId, at);
    void (0, db_1.touchLastSeen)(userId, at);
}
/**
 * Регистрирует соединение. Если оно первое у пользователя — рассылает друзьям
 * статус. Затем отдаёт этому сокету снапшот: статусы его друзей и время
 * последнего присутствия остальных.
 */
async function trackConnect(nsp, socket, userId) {
    const now = Date.now();
    // Вернулся внутри grace-окна — отменяем отложенный оффлайн. Собеседник в
    // этом случае вообще не увидел разрыва: reload проходит незаметно.
    const pendingOffline = offlineTimers.get(userId);
    if (pendingOffline) {
        clearTimeout(pendingOffline);
        offlineTimers.delete(userId);
    }
    let sockets = connections.get(userId);
    // Именно сводный статус, а не «есть ли сокеты»: у пользователя могли остаться
    // только свёрнутые вкладки, и для друзей он в этот момент оффлайн.
    const statusBefore = statusOf(userId);
    if (!sockets) {
        sockets = new Map();
        connections.set(userId, sockets);
    }
    sockets.set(socket.id, { status: 'online', lastPingAt: now });
    // Пользователь здесь и сейчас — фиксируем сразу, не дожидаясь первого
    // периодического сброса: короткая сессия иначе не оставила бы времени.
    flushLastSeen(userId, now, true);
    const friends = await friendsOf(userId);
    // Рассылаем только когда сводный статус реально изменился. Вторая активная
    // вкладка ничего не меняет для друзей, а вот новая вкладка при остальных
    // свёрнутых (сводный статус был offline) — меняет.
    if (statusBefore !== 'online') {
        for (const friendId of friends) {
            nsp.to((0, namespace_types_1.userRoom)(friendId)).emit('dm:presence', { userId, status: 'online' });
        }
    }
    // lastSeenAt читаем из БД: в памяти его больше нет, и именно поэтому снапшот
    // теперь остаётся содержательным после рестарта сервера.
    const [statuses, lastSeenAt] = await Promise.all([
        Promise.resolve(statusesFor(friends)),
        (0, db_1.getLastSeenBulk)(friends),
    ]);
    socket.emit('dm:presence:snapshot', { statuses, lastSeenAt });
}
/**
 * Отметить активность соединения (прикладной heartbeat) и, опционально,
 * сменить статус вкладки. Возвращает true, если сводный статус изменился и его
 * нужно разослать.
 */
function trackPing(userId, socketId, status) {
    const sockets = connections.get(userId);
    const presence = sockets?.get(socketId);
    if (!presence)
        return false;
    const before = statusOf(userId);
    presence.lastPingAt = Date.now();
    if (status)
        presence.status = status;
    const after = statusOf(userId);
    // lastSeenAt двигаем только пока человек действительно у экрана. Пинги от
    // свёрнутых вкладок сюда тоже приходят (соединение живо), и если бы они
    // обновляли время, у друзей навсегда осталось бы «был(а) только что» вместо
    // растущего «N минут назад».
    if (after !== 'offline')
        flushLastSeen(userId, presence.lastPingAt);
    return after !== before;
}
/**
 * Сменить статус вкладки и разослать сводный статус, если он изменился.
 *
 * Переход в оффлайн (все вкладки свернули) уходит вместе с lastSeenAt и
 * принудительно фиксируется в БД: клиент по этому времени рисует «был(а) в сети
 * только что», а перезагрузка страницы собеседника берёт то же значение из
 * снапшота.
 */
async function setSocketStatus(nsp, socket, userId, status) {
    if (!trackPing(userId, socket.id, status))
        return;
    await broadcastCurrentStatus(nsp, userId);
}
/**
 * Разослать друзьям текущий сводный статус. Оффлайн (например, все вкладки
 * ушли в фон при живых соединениях) всегда уходит вместе с lastSeenAt и
 * принудительной записью в БД: по этому времени UI рисует «был(а) в сети только
 * что», и то же значение потом приходит в снапшоте после перезагрузки.
 */
async function broadcastCurrentStatus(nsp, userId) {
    const status = statusOf(userId);
    if (status !== 'offline') {
        await broadcastStatus(nsp, userId, status);
        return;
    }
    const at = Date.now();
    flushLastSeen(userId, at, true);
    await broadcastStatus(nsp, userId, 'offline', at);
}
/**
 * Снимает соединение с учёта. Оффлайн объявляем только когда у пользователя не
 * осталось ни одного сокета — и не мгновенно, а после grace-окна.
 *
 * `immediate` — для beacon'а при закрытии вкладки: там уход осознанный, ждать
 * возврата не нужно, и точка у собеседника гаснет сразу.
 *
 * Учёт соединений правится СИНХРОННО, до первого await: на это опирается
 * namespace.ts, где сразу после вызова проверяется isOnline для уборки звонков.
 */
function trackDisconnect(nsp, socketId, userId, immediate = false) {
    const sockets = connections.get(userId);
    if (!sockets)
        return;
    sockets.delete(socketId);
    if (sockets.size > 0)
        return;
    connections.delete(userId);
    // Время разрыва фиксируем сейчас, а не когда истечёт grace: иначе «был(а)
    // только что» отставало бы на длину окна.
    const at = Date.now();
    flushLastSeen(userId, at, true);
    lastFlushAt.delete(userId);
    const announceOffline = () => {
        offlineTimers.delete(userId);
        // Мог вернуться, пока таймер ждал — тогда объявлять оффлайн нечего.
        if (isOnline(userId))
            return;
        void broadcastStatus(nsp, userId, 'offline', at);
    };
    if (immediate) {
        const pending = offlineTimers.get(userId);
        if (pending) {
            clearTimeout(pending);
            offlineTimers.delete(userId);
        }
        announceOffline();
        return;
    }
    if (offlineTimers.has(userId))
        return;
    offlineTimers.set(userId, setTimeout(announceOffline, OFFLINE_GRACE_MS));
}
/**
 * Убрать соединения, замолчавшие дольше PING_TIMEOUT_MS.
 *
 * Ловит случаи, когда disconnect не приходит вовсе или приходит слишком поздно:
 * убитый процесс браузера, спящий ноутбук, пропавшая сеть. Движок заметит это
 * лишь через свой pingTimeout (30 с), а здесь важна реакция за секунды.
 *
 * Оффлайн объявляем без grace: тишина дольше PING_TIMEOUT_MS уже сама себе
 * grace-окно, ждать ещё восемь секунд незачем.
 */
function sweepStaleSockets(nsp) {
    const now = Date.now();
    for (const [userId, sockets] of connections) {
        let changed = false;
        for (const [socketId, presence] of sockets) {
            if (now - presence.lastPingAt <= PING_TIMEOUT_MS)
                continue;
            // Сокет мог просто не поддерживать наш heartbeat (старый клиент из
            // закэшированного бандла): проверяем, что соединения действительно нет,
            // прежде чем гасить точку.
            const live = nsp.sockets.get(socketId);
            if (live?.connected) {
                presence.lastPingAt = now;
                continue;
            }
            sockets.delete(socketId);
            changed = true;
        }
        if (!changed)
            continue;
        if (sockets.size === 0) {
            connections.delete(userId);
            lastFlushAt.delete(userId);
            const at = now;
            flushLastSeen(userId, at, true);
            void broadcastStatus(nsp, userId, 'offline', at);
        }
        else {
            // Остались соединения, но сводный статус мог стать любым, включая offline
            // (все выжившие вкладки в фоне) — тогда helper приложит lastSeenAt.
            void broadcastCurrentStatus(nsp, userId);
        }
    }
}
/** Запустить фоновый свипер. Вызывается один раз при поднятии namespace /dm. */
function startPresenceSweeper(nsp) {
    const timer = setInterval(() => sweepStaleSockets(nsp), SWEEP_INTERVAL_MS);
    // unref, чтобы таймер не держал процесс при graceful shutdown.
    timer.unref();
}
