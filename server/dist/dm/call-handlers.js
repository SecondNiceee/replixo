"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleCallCleanup = scheduleCallCleanup;
exports.cancelCallCleanup = cancelCallCleanup;
exports.syncCallsForSocket = syncCallsForSocket;
exports.registerCallHandlers = registerCallHandlers;
const node_crypto_1 = require("node:crypto");
const helpers_1 = require("../socket/helpers");
const room_registry_1 = require("../socket/room-registry");
const db_1 = require("./db");
const presence_1 = require("./presence");
const namespace_types_1 = require("./namespace-types");
// ---------------------------------------------------------------------------
// Звонок из личного чата: «позвонить другу» → у него на экране входящий вызов
// → принял, и оба оказываются в одной комнате.
//
// Состояние — in-memory, как presence и реестр комнат: звонок живёт секунды,
// переживать перезапуск сервера ему незачем, а после перезапуска все websocket
// всё равно порваны и звонить уже некому.
//
// Комнату здесь НЕ создаём: корневой namespace поднимает её на первом
// joinRoom. Мы лишь заранее договариваемся о коде, чтобы оба участника пришли
// в одну и ту же комнату — иначе принявшему пришлось бы получать код отдельным
// сообщением. Но код при этом сразу помечается в реестре комнат как
// разрешённый к созданию (`allowRoomCreation`): по ссылке звонка идут оба
// участника без флага `create`, и без этой пометки первый же из них получил бы
// «Комната не найдена».
// ---------------------------------------------------------------------------
/**
 * Сколько держится попытка звонка, прежде чем закончиться сама.
 *
 * Минута одинаково отсчитывается и для друга в сети, и для того, кто ещё не
 * открыл сайт: во втором случае это же время работает запасом на то, чтобы он
 * успел зайти и увидеть вызов. По истечении звонок просто заканчивается как
 * «не ответил», и можно позвонить заново.
 */
const RING_TIMEOUT_MS = 60000;
/** Без похожих друг на друга символов: код диктуют голосом и вводят руками. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/**
 * Сколько ждать возвращения пользователя, прежде чем гасить его звонки.
 *
 * Обновление страницы, переход по ссылке и мигнувшая сеть рвут websocket — а
 * звонок при этом продолжается. Без этой отсрочки собеседник, нажавший F5 в
 * момент вызова, обрывал бы звонок самому себе.
 */
const RECONNECT_GRACE_MS = 15000;
/** callId → звонок в состоянии «звоним». */
const pending = new Map();
/** userId → отложенная уборка его звонков после разрыва последнего соединения. */
const cleanupTimers = new Map();
function generateRoomCode() {
    let code = '';
    for (let i = 0; i < 8; i += 1) {
        if (i === 4)
            code += '-';
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
}
function forget(call) {
    clearTimeout(call.timer);
    pending.delete(call.callId);
}
/**
 * Звонок закончился, не начавшись (отклонили, отменили, не дождались) — снять
 * разрешение на создание комнаты, если в неё так никто и не зашёл. Если комната
 * уже поднята, разрешение не трогаем: участник может обновить страницу и
 * вернуться в неё.
 */
function dropUnusedRoom(roomId) {
    if (!room_registry_1.rooms.has(roomId))
        (0, room_registry_1.revokeRoomCreation)(roomId);
}
/** Звонок между этой парой уже идёт? Повторный клик не должен звонить дважды. */
function findBetween(fromUserId, toUserId) {
    for (const call of pending.values()) {
        if (call.fromUserId === fromUserId && call.toUserId === toUserId)
            return call;
    }
    return null;
}
/** Звонки, в которых пользователь участвует любой из сторон. */
function callsOf(userId) {
    return [...pending.values()].filter((call) => call.fromUserId === userId || call.toUserId === userId);
}
function endCallsForUser(nsp, userId) {
    for (const call of callsOf(userId)) {
        forget(call);
        dropUnusedRoom(call.roomId);
        const otherId = call.fromUserId === userId ? call.toUserId : call.fromUserId;
        nsp.to((0, namespace_types_1.userRoom)(otherId)).emit('call:ended', { callId: call.callId, reason: 'gone' });
        // И собственным устройствам того, кто ушёл: они могли остаться открытыми.
        nsp.to((0, namespace_types_1.userRoom)(userId)).emit('call:ended', { callId: call.callId, reason: 'gone' });
    }
}
/**
 * Пользователь потерял последнее соединение — погасить его звонки, но не
 * сразу: сначала дать ему шанс вернуться (см. RECONNECT_GRACE_MS). Если он
 * успел переподключиться, уборку отменит `cancelCallCleanup`.
 */
function scheduleCallCleanup(nsp, userId) {
    if (cleanupTimers.has(userId) || callsOf(userId).length === 0)
        return;
    const timer = setTimeout(() => {
        cleanupTimers.delete(userId);
        // Мог вернуться и снова уйти, пока таймер ждал: решает текущий presence.
        if ((0, presence_1.isOnline)(userId))
            return;
        endCallsForUser(nsp, userId);
    }, RECONNECT_GRACE_MS);
    cleanupTimers.set(userId, timer);
}
function cancelCallCleanup(userId) {
    const timer = cleanupTimers.get(userId);
    if (!timer)
        return;
    clearTimeout(timer);
    cleanupTimers.delete(userId);
}
/**
 * Отдать новому сокету звонки, которые уже идут.
 *
 * `call:incoming` рассылается один раз, в момент вызова, поэтому устройство,
 * подключившееся посреди звонка (открыли вторую вкладку, обновили страницу,
 * зашли с телефона), о нём бы не узнало. Досылаем состояние при подключении —
 * тот же приём, что и снапшот presence.
 */
function syncCallsForSocket(socket, userId) {
    const calls = callsOf(userId);
    if (calls.length === 0)
        return;
    socket.emit('call:sync', {
        incoming: calls
            .filter((call) => call.toUserId === userId)
            .map((call) => ({
            callId: call.callId,
            roomId: call.roomId,
            fromUserId: call.fromUserId,
            fromName: call.fromName,
            createdAt: call.createdAt,
            expiresAt: call.expiresAt,
        })),
        outgoing: calls
            .filter((call) => call.fromUserId === userId)
            .map((call) => ({
            callId: call.callId,
            roomId: call.roomId,
            toUserId: call.toUserId,
            toName: call.toName,
            createdAt: call.createdAt,
            expiresAt: call.expiresAt,
        })),
    });
}
function respond(cb, payload) {
    if (typeof cb === 'function')
        cb(payload);
}
function readCallId(payload) {
    const { callId } = (payload ?? {});
    return typeof callId === 'string' && callId.length > 0 && callId.length <= 64 ? callId : null;
}
function registerCallHandlers(nsp, socket) {
    const data = socket.data;
    // Звонок — действие редкое и дорогое: пять попыток за десять секунд с
    // запасом покрывают «нажал ещё раз, потому что не дозвонился».
    const allowInvite = (0, helpers_1.createRateLimiter)(5, 10000);
    const allowAnswer = (0, helpers_1.createRateLimiter)(20, 10000);
    // --- Позвонить ---------------------------------------------------------
    socket.on('call:invite', async (payload, cb) => {
        const fromUserId = data.userId;
        if (!fromUserId) {
            respond(cb, { ok: false, error: 'unauthorized' });
            return;
        }
        if (!allowInvite()) {
            respond(cb, { ok: false, error: 'rate_limited' });
            return;
        }
        const { peerId, peerName } = (payload ?? {});
        if (typeof peerId !== 'string' || !peerId || peerId.length > 64 || peerId === fromUserId) {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        // Имя нужно только чтобы вернуть его же звонящему при переподключении, так
        // что доверять клиенту тут безопасно — обрезаем лишь длину.
        const toName = typeof peerName === 'string' ? peerName.slice(0, 120) : '';
        // Звонить можно только принятому другу — то же правило, что и на отправку
        // сообщений. Иначе звонок стал бы каналом для навязчивых незнакомцев.
        if (!(await (0, db_1.areFriends)(fromUserId, peerId))) {
            respond(cb, { ok: false, error: 'not_friends' });
            return;
        }
        // Отсутствие адресата в сети звонку не мешает: он повисит в `pending`, а
        // когда человек откроет сайт, `syncCallsForSocket` покажет ему вызов на
        // подключившемся устройстве. Поэтому presence здесь не проверяется вообще —
        // минуты ожидания хватает и на ответ, и на то, чтобы успеть зайти.
        // Повторный клик по кнопке: отдаём тот же звонок, второй раз не звоним.
        const existing = findBetween(fromUserId, peerId);
        if (existing) {
            respond(cb, { ok: true, callId: existing.callId, roomId: existing.roomId });
            return;
        }
        const callId = (0, node_crypto_1.randomUUID)();
        const roomId = generateRoomCode();
        // Комнаты с этим кодом ещё нет, и создавать её здесь нечем: mediasoup-router
        // живёт в корневом namespace. Поэтому разрешаем поднять её первому, кто
        // придёт по коду — иначе и звонящий, и принявший получали бы «Комната не
        // найдена», ведь ни один из них не заходит с флагом create.
        (0, room_registry_1.allowRoomCreation)(roomId);
        const fromName = data.username ?? data.name ?? '';
        const createdAt = Date.now();
        const expiresAt = createdAt + RING_TIMEOUT_MS;
        const call = {
            callId,
            roomId,
            fromUserId,
            fromName,
            toUserId: peerId,
            toName,
            createdAt,
            expiresAt,
            timer: setTimeout(() => {
                pending.delete(callId);
                dropUnusedRoom(roomId);
                nsp.to((0, namespace_types_1.userRoom)(peerId)).emit('call:ended', { callId, reason: 'timeout' });
                nsp.to((0, namespace_types_1.userRoom)(fromUserId)).emit('call:ended', { callId, reason: 'timeout' });
            }, RING_TIMEOUT_MS),
        };
        pending.set(callId, call);
        // Во все устройства адресата: звонок должен догнать его там, где он есть.
        nsp.to((0, namespace_types_1.userRoom)(peerId)).emit('call:incoming', {
            callId,
            roomId,
            fromUserId,
            fromName,
            createdAt,
            expiresAt,
        });
        respond(cb, { ok: true, callId, roomId, expiresAt });
        console.log(`[call] ${fromUserId} → ${peerId} room=${roomId} call=${callId}`);
    });
    // --- Принять ----------------------------------------------------------
    socket.on('call:accept', (payload, cb) => {
        const userId = data.userId;
        const callId = readCallId(payload);
        if (!userId || !callId || !allowAnswer()) {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        const call = pending.get(callId);
        // Принять может только адресат: иначе звонящий мог бы «ответить сам себе»
        // и затащить собеседника в комнату без его согласия.
        if (!call || call.toUserId !== userId) {
            respond(cb, { ok: false, error: 'not_found' });
            return;
        }
        forget(call);
        // Обеим сторонам, во все устройства: у звонящего гаснет «звоним…» и он
        // уходит в комнату, у принявшего закрываются остальные вкладки с вызовом.
        const accepted = { callId, roomId: call.roomId };
        nsp.to((0, namespace_types_1.userRoom)(call.fromUserId)).emit('call:accepted', accepted);
        nsp.to((0, namespace_types_1.userRoom)(call.toUserId)).emit('call:accepted', accepted);
        respond(cb, { ok: true, roomId: call.roomId });
        console.log(`[call] accepted room=${call.roomId} call=${callId}`);
    });
    // --- Отклонить / отменить ---------------------------------------------
    // Одно событие на оба случая: разница только в том, кто его прислал, а
    // проверку «участник этого звонка» всё равно делать одинаковую.
    socket.on('call:hangup', (payload, cb) => {
        const userId = data.userId;
        const callId = readCallId(payload);
        if (!userId || !callId || !allowAnswer()) {
            respond(cb, { ok: false, error: 'bad_payload' });
            return;
        }
        const call = pending.get(callId);
        if (!call || (call.fromUserId !== userId && call.toUserId !== userId)) {
            respond(cb, { ok: false, error: 'not_found' });
            return;
        }
        forget(call);
        dropUnusedRoom(call.roomId);
        // Причина зависит от того, кто нажал: звонящий отменил вызов, адресат
        // отклонил. Клиент по ней выбирает текст уведомления.
        const reason = call.fromUserId === userId ? 'cancelled' : 'declined';
        nsp.to((0, namespace_types_1.userRoom)(call.fromUserId)).emit('call:ended', { callId, reason });
        nsp.to((0, namespace_types_1.userRoom)(call.toUserId)).emit('call:ended', { callId, reason });
        respond(cb, { ok: true });
        console.log(`[call] ${reason} room=${call.roomId} call=${callId}`);
    });
}
