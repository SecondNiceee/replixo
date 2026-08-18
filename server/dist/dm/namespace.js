"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupDmNamespace = setupDmNamespace;
const db_1 = require("./db");
const handlers_1 = require("./handlers");
const call_handlers_1 = require("./call-handlers");
const presence_1 = require("./presence");
const namespace_types_1 = require("./namespace-types");
/**
 * Достать статус вкладки из чего угодно, что прислал клиент: handshake, dm:ping,
 * dm:status. Всё три источника недоверенные и приходят одинаковой формы, поэтому
 * разбор один. undefined означает «клиент статуса не сообщил» — так ведёт себя
 * старый бандл из кэша браузера, и для него presence должен работать как раньше.
 *
 * Список значений — граница доверия: неизвестное значение здесь становится
 * undefined, то есть «статус не сообщён», а не ошибкой. Поэтому забыть добавить
 * сюда новое значение опасно молча: 'call' раньше отбрасывался, и вкладка в
 * звонке для сервера выглядела как вкладка, которая о себе вообще ничего не
 * сказала.
 */
const KNOWN_STATUSES = ['online', 'hidden', 'call'];
function readStatus(value) {
    if (KNOWN_STATUSES.includes(value))
        return value;
    // 'idle' присылают бандлы, закэшированные до отказа от статуса «отошёл».
    // Такая вкладка открыта на экране и сообщает о себе честно — она лишь называет
    // бездействие отдельным словом, которого у нас больше нет. Трактуем как
    // присутствие: иначе у пользователя со старой вкладкой точка гасла бы через
    // минуту тишины и не зажигалась до перезагрузки страницы.
    if (value === 'idle')
        return 'online';
    return undefined;
}
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
        //
        // Статус вкладки берём из handshake: вкладка могла открыться сразу в фоне
        // (Ctrl+click, восстановление сессии браузера) или это реконнект свёрнутого
        // окна. Без него presence обязан был предполагать 'online', и у друзей
        // мигала зелёная точка, тут же сменяясь на «был(а) только что».
        const initialStatus = readStatus(socket.handshake.auth?.status);
        void (0, presence_1.trackConnect)(nsp, socket, userId, initialStatus);
        // Досылаем этому устройству звонки, которые уже идут: `call:incoming`
        // рассылался один раз, и подключившийся посреди звонка о нём бы не узнал.
        (0, call_handlers_1.syncCallsForSocket)(socket, userId);
        // --- Прикладной heartbeat presence ------------------------------------
        // Свой пинг поверх движкового нужен потому, что pingTimeout у Socket.IO —
        // 30 секунд, и понижать его нельзя: на нём держится устойчивость звонков к
        // мигнувшей сети. Presence же должен реагировать за секунды, поэтому у него
        // отдельный, более чуткий таймер (см. PING_TIMEOUT_MS в presence.ts).
        socket.on('dm:ping', (payload) => {
            // Пинг НЕСЁТ СОСТОЯНИЕ ВКЛАДКИ, а не только факт «я жив».
            //
            // Благодаря этому presence самовосстанавливается: каждый heartbeat — это
            // полная правда о вкладке, поэтому потерянное dm:status, реконнект или
            // понижение статуса свипером исправляются сами на следующем пинге. Без
            // этого расхождение могло держаться до перезагрузки страницы.
            //
            // Статуса может и не быть (старый бандл из кэша браузера) — тогда пинг
            // работает как раньше, просто продлевая жизнь соединения.
            const status = readStatus(payload?.status);
            if ((0, presence_1.trackPing)(userId, socket.id, status)) {
                void (0, presence_1.broadcastCurrentStatus)(nsp, userId);
            }
        });
        // Вкладка сообщает, что ушла в фон, вернулась на экран или вошла в звонок.
        // Статус хранится на каждый сокет: сводный считается по всем устройствам,
        // поэтому свёрнутая вкладка на ноутбуке не гасит активность на телефоне.
        socket.on('dm:status', (payload) => {
            const status = readStatus(payload?.status);
            if (!status)
                return;
            void (0, presence_1.setSocketStatus)(nsp, socket, userId, status);
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
