"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupDmNamespace = setupDmNamespace;
const db_1 = require("./db");
const handlers_1 = require("./handlers");
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
        // join уже выполнен, поэтому снапшот presence гарантированно дойдёт.
        void (0, presence_1.trackConnect)(nsp, socket, userId);
        socket.on('disconnect', () => {
            void (0, presence_1.trackDisconnect)(nsp, socket, userId);
            console.log(`[dm] Отключён ${userId} (socket ${socket.id})`);
        });
    });
    console.log('[dm] Namespace /dm поднят');
}
