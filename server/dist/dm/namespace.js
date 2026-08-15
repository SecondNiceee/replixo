"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupDmNamespace = setupDmNamespace;
const db_1 = require("./db");
const handlers_1 = require("./handlers");
const call_handlers_1 = require("./call-handlers");
const presence_1 = require("./presence");
const namespace_types_1 = require("./namespace-types");
// ---------------------------------------------------------------------------
// Namespace /dm — личные сообщения между друзьями.
//
// Полностью изолирован от корневого namespace (комнаты/звонки): свой
// auth-middleware, свои события, своё хранилище. Ломать звонки он не может.
// ---------------------------------------------------------------------------
function setupDmNamespace(io) {
    if (!(0, db_1.isDmEnabled)()) {
        console.warn('[dm] DATABASE_URL не задан — личный чат отключён (namespace /dm не поднят).');
        return;
    }
    const nsp = io.of('/dm');
    // --- Аутентификация: токен сессии Better Auth из handshake --------------
    nsp.use(async (socket, next) => {
        const raw = socket.handshake.auth?.token;
        const token = typeof raw === 'string' ? raw : '';
        if (!token) {
            next(new Error('unauthorized'));
            return;
        }
        const identity = await (0, db_1.validateSessionToken)(token);
        if (!identity) {
            next(new Error('unauthorized'));
            return;
        }
        const data = socket.data;
        data.userId = identity.userId;
        data.name = identity.name;
        data.username = identity.username;
        next();
    });
    nsp.on('connection', (socket) => {
        const data = socket.data;
        const userId = data.userId;
        if (!userId) {
            socket.disconnect(true);
            return;
        }
        // Личная комната пользователя — адрес доставки для всех его устройств.
        void socket.join((0, namespace_types_1.userRoom)(userId));
        console.log(`[dm] Подключён ${userId} (socket ${socket.id})`);
        (0, handlers_1.registerDmHandlers)(nsp, socket);
        (0, call_handlers_1.registerCallHandlers)(nsp, socket);
        // Пользователь вернулся раньше, чем истёк grace-период после разрыва:
        // отменяем отложенную уборку, иначе она погасила бы живой звонок.
        (0, call_handlers_1.cancelCallCleanup)(userId);
        // join уже выполнен, поэтому снапшот presence гарантированно дойдёт.
        void (0, presence_1.trackConnect)(nsp, socket, userId);
        // Досылаем этому устройству звонки, которые уже идут: `call:incoming`
        // рассылался один раз, и подключившийся посреди звонка о нём бы не узнал.
        (0, call_handlers_1.syncCallsForSocket)(socket, userId);
        // --- Прикладной heartbeat presence ------------------------------------
        // Свой пинг поверх движкового нужен потому, что pingTimeout у Socket.IO —
        // 30 секунд, и понижать его нельзя: на нём держится устойчивость звонков к
        // мигнувшей сети. Presence же должен реагировать за секунды, поэтому у него
        // отдельный, более чуткий таймер (см. PING_TIMEOUT_MS в presence.ts).
        socket.on('dm:ping', () => {
            // Изменение сводного статуса возможно и здесь: пинг оживляет соединение,
            // которое свипер мог считать замолчавшим.
            // Статус вкладки при этом НЕ переписываем: свёрнутая вкладка тоже шлёт
            // пинги (соединение живо), и «online» здесь вернул бы ей зелёную точку.
            if ((0, presence_1.trackPing)(userId, socket.id)) {
                void (0, presence_1.broadcastCurrentStatus)(nsp, userId);
            }
        });
        // Вкладка сообщает, что пользователь отошёл, вернулся или ушёл в фон.
        // Статус хранится на каждый сокет: сводный считается по всем устройствам,
        // поэтому свёрнутая вкладка на ноутбуке не гасит активность на телефоне.
        socket.on('dm:status', (payload) => {
            const raw = (payload ?? {});
            if (raw.status !== 'online' && raw.status !== 'idle' && raw.status !== 'hidden')
                return;
            void (0, presence_1.setSocketStatus)(nsp, socket, userId, raw.status);
        });
        socket.on('disconnect', () => {
            (0, presence_1.trackDisconnect)(nsp, socket.id, userId);
            // Учёт соединений trackDisconnect правит синхронно (до первого await),
            // поэтому isOnline здесь уже отвечает про состояние ПОСЛЕ разрыва.
            // Ушло последнее соединение — незавершённые звонки надо погасить, иначе у
            // собеседника входящий вызов остался бы висеть до таймаута. Но не сразу:
            // reload и мигнувшая сеть тоже рвут websocket, поэтому даём шанс
            // вернуться, а вернувшемуся состояние досылает syncCallsForSocket.
            if (!(0, presence_1.isOnline)(userId))
                (0, call_handlers_1.scheduleCallCleanup)(nsp, userId);
            console.log(`[dm] Отключён ${userId} (socket ${socket.id})`);
        });
    });
    // Фоновая уборка замолчавших соединений: ловит убитый браузер и пропавшую
    // сеть, о которых disconnect не приходит или приходит слишком поздно.
    (0, presence_1.startPresenceSweeper)(nsp);
    console.log('[dm] Namespace /dm поднят');
}
