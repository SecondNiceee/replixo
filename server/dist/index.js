"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Должен идти первым: патчит console, чтобы каждая строка логов имела дату/время.
require("./logger");
require("dotenv/config");
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const multer_1 = __importDefault(require("multer"));
const mediasoup = __importStar(require("mediasoup"));
const fs_1 = __importDefault(require("fs"));
const config_1 = require("./config");
const socket_1 = require("./socket");
const room_code_1 = require("./room-code");
const room_registry_1 = require("./socket/room-registry");
const uploads_1 = require("./uploads");
const db_1 = require("./dm/db");
const internal_routes_1 = require("./dm/internal-routes");
const uploads_2 = require("./dm/uploads");
async function main() {
    // ---------------------------------------------------------------------------
    // Express + HTTP server
    // ---------------------------------------------------------------------------
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)({ origin: config_1.CLIENT_ORIGIN }));
    app.use(express_1.default.json());
    // Health check
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });
    // ---------------------------------------------------------------------------
    // Вложения чата (файлы на диске VPS)
    // ---------------------------------------------------------------------------
    (0, uploads_1.ensureUploadRoot)();
    // Раздача загруженных файлов. Заголовки безопасности:
    //  - nosniff: браузер не угадывает тип (иначе загруженный .html мог бы
    //    выполниться как страница);
    //  - не-картинки отдаём как attachment (скачивание), картинки — inline, чтобы
    //    показывать превью прямо в чате.
    app.use('/uploads', express_1.default.static(config_1.UPLOAD_DIR, {
        index: false,
        setHeaders: (res, filePath) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'private, max-age=86400');
            const ext = path_1.default.extname(filePath).toLowerCase();
            const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'].includes(ext);
            if (!isImage)
                res.setHeader('Content-Disposition', 'attachment');
        },
    }));
    // Загрузка файла в папку конкретной комнаты. multer кладёт файл на диск с
    // безопасным случайным именем; оригинальное имя возвращается клиенту и
    // хранится в сообщении.
    const storage = multer_1.default.diskStorage({
        destination: (req, _file, cb) => {
            const roomId = (0, room_code_1.canonicalRoomCode)(req.params.roomId);
            if (!roomId) {
                cb(new Error('invalid roomId'), '');
                return;
            }
            req.params.roomId = roomId;
            try {
                cb(null, (0, uploads_1.ensureRoomDir)(roomId));
            }
            catch (e) {
                cb(e, '');
            }
        },
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname).slice(0, 16);
            cb(null, `${(0, crypto_1.randomUUID)()}${ext}`);
        },
    });
    const upload = (0, multer_1.default)({
        storage,
        limits: { fileSize: config_1.MAX_FILE_SIZE, files: 1 },
    });
    app.post('/rooms/:roomId/upload', (req, res) => {
        const roomId = (0, room_code_1.canonicalRoomCode)(req.params.roomId);
        if (!roomId) {
            res.status(400).json({ error: 'invalid roomId' });
            return;
        }
        upload.single('file')(req, res, (uploadErr) => {
            if (uploadErr) {
                const message = uploadErr.message ?? 'upload failed';
                const tooLarge = message.includes('File too large');
                res.status(tooLarge ? 413 : 400).json({
                    error: tooLarge ? 'Файл слишком большой' : message,
                });
                return;
            }
            const file = req.file;
            if (!file) {
                res.status(400).json({ error: 'no file' });
                return;
            }
            // URL относительный — клиент сам подставит адрес сервера. Декодировать
            // не нужно: имя — это сгенерированный UUID + расширение.
            res.json({
                url: `/uploads/${roomId}/${file.filename}`,
                name: file.originalname.slice(0, 255),
                size: file.size,
                mime: file.mimetype || 'application/octet-stream',
            });
        });
    });
    // ---------------------------------------------------------------------------
    // Вложения личных чатов: POST /dm/:conversationId/upload
    //
    // В отличие от /rooms/:roomId/upload здесь авторизация ОБЯЗАТЕЛЬНА: комната —
    // это одноразовый код, который знают только участники звонка, а диалог живёт
    // постоянно и его id вычислим из пары userId. Проверяем в таком порядке:
    //   формат id → сессия → membership → rate limit → и только затем пишем файл.
    // Порядок важен: multer начинает писать на диск сразу, поэтому все отказы
    // должны случиться до него, иначе неавторизованный запрос уже занял место.
    // ---------------------------------------------------------------------------
    const dmStorage = multer_1.default.diskStorage({
        destination: (req, _file, cb) => {
            const conversationId = req.params.conversationId;
            if (!(0, uploads_2.isValidConversationId)(conversationId)) {
                cb(new Error('invalid conversationId'), '');
                return;
            }
            try {
                cb(null, (0, uploads_2.ensureDmConversationDir)(conversationId));
            }
            catch (e) {
                cb(e, '');
            }
        },
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname).slice(0, 16);
            cb(null, `${(0, crypto_1.randomUUID)()}${ext}`);
        },
    });
    const dmUpload = (0, multer_1.default)({
        storage: dmStorage,
        limits: { fileSize: config_1.MAX_FILE_SIZE, files: 1 },
    });
    app.post('/dm/:conversationId/upload', (req, res) => {
        void (async () => {
            const conversationId = req.params.conversationId;
            if (!(0, uploads_2.isValidConversationId)(conversationId)) {
                res.status(400).json({ error: 'invalid conversationId' });
                return;
            }
            if (!(0, db_1.isDmEnabled)()) {
                res.status(503).json({ error: 'Чат недоступен' });
                return;
            }
            // Токен сессии передаёт Next-прокси (/api/chat/upload): браузер не имеет
            // доступа к httpOnly-cookie, а кросс-доменный cookie сюда не долетит.
            const header = req.header('authorization') ?? '';
            const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
            if (!token) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            const identity = await (0, db_1.validateSessionToken)(token);
            if (!identity) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            if (!(await (0, db_1.isMember)(conversationId, identity.userId))) {
                res.status(403).json({ error: 'Нет доступа к диалогу' });
                return;
            }
            if (!(0, uploads_2.allowDmUpload)(identity.userId)) {
                res.status(429).json({ error: 'Слишком много файлов, попробуйте позже' });
                return;
            }
            dmUpload.single('file')(req, res, (uploadErr) => {
                if (uploadErr) {
                    const message = uploadErr.message ?? 'upload failed';
                    const tooLarge = message.includes('File too large');
                    res.status(tooLarge ? 413 : 400).json({
                        error: tooLarge ? 'Файл слишком большой' : message,
                    });
                    return;
                }
                const file = req.file;
                if (!file) {
                    res.status(400).json({ error: 'no file' });
                    return;
                }
                // Именно этот префикс потом проверяет dm:send — ссылка привязана к
                // диалогу, так что подставить чужую не получится.
                res.json({
                    url: `${(0, uploads_2.dmUrlPrefix)(conversationId)}${file.filename}`,
                    name: file.originalname.slice(0, 255),
                    size: file.size,
                    mime: file.mimetype || 'application/octet-stream',
                });
            });
        })().catch((e) => {
            console.error('[dm] upload failed:', e.message);
            if (!res.headersSent)
                res.status(500).json({ error: 'upload failed' });
        });
    });
    // ---------------------------------------------------------------------------
    // Скачивание установщика приложения (Windows .exe, ~900 МБ).
    //
    // Файл лежит на диске VPS (WINDOWS_INSTALLER_PATH) и НЕ хранится в git.
    // res.download() использует модуль send: он сам выставляет Content-Length,
    // Accept-Ranges и обрабатывает Range-запросы — то есть поддерживает докачку
    // и докачивание после обрыва, что критично для большого файла.
    // ---------------------------------------------------------------------------
    app.get('/download/windows', (_req, res) => {
        fs_1.default.access(config_1.WINDOWS_INSTALLER_PATH, fs_1.default.constants.R_OK, (err) => {
            if (err) {
                console.error(`[download] Установщик не найден: ${config_1.WINDOWS_INSTALLER_PATH}`);
                res.status(404).json({ error: 'Установщик временно недоступен' });
                return;
            }
            res.download(config_1.WINDOWS_INSTALLER_PATH, config_1.WINDOWS_INSTALLER_NAME, (dlErr) => {
                // Частая «ошибка» — клиент оборвал соединение (закрыл вкладку/пауза).
                // Это не повод шуметь в логах как о настоящей проблеме.
                if (dlErr && !res.headersSent) {
                    console.error('[download] Ошибка отдачи установщика:', dlErr.message);
                }
            });
        });
    });
    const httpServer = http_1.default.createServer(app);
    // ---------------------------------------------------------------------------
    // Mediasoup Worker
    // ---------------------------------------------------------------------------
    const worker = await mediasoup.createWorker(config_1.workerSettings);
    worker.on('died', (error) => {
        console.error('[mediasoup] Worker died, exiting in 2 seconds...', error);
        setTimeout(() => process.exit(1), 2000);
    });
    console.log(`[mediasoup] Worker created (pid: ${worker.pid})`);
    // ---------------------------------------------------------------------------
    // Socket.io
    // ---------------------------------------------------------------------------
    const io = (0, socket_1.setupSocketIO)(httpServer, worker);
    // Маршруты «Next-сервер → сокет-сервер». Регистрируются после io, потому что
    // им нужен namespace /dm для рассылки. Защищены общим секретом.
    (0, internal_routes_1.registerInternalRoutes)(app, io);
    // ---------------------------------------------------------------------------
    // "Я закрываю вкладку" — beacon от клиента (navigator.sendBeacon на
    // pagehide/beforeunload). sendBeacon надёжно доставляется во время выгрузки
    // страницы, в отличие от socket.emit. Мы НЕ удаляем участника мгновенно:
    // ставим короткое окно CLOSE_GRACE_MS, чтобы перезагрузка страницы или
    // случайный быстрый возврат успели отменить удаление через
    // rejoinProbe/joinRoom. Реальное закрытие вкладки/браузера — никто не
    // вернётся, и остальные увидят выход почти сразу (а не через полное
    // grace-окно, как при обычном обрыве сети). sendBeacon шлёт POST; мы читаем
    // peerId из query, тела нет — парсер не нужен.
    // ---------------------------------------------------------------------------
    app.post('/rooms/:roomId/leave', (req, res) => {
        const roomId = (0, room_code_1.canonicalRoomCode)(req.params.roomId);
        const peerId = typeof req.query.peerId === 'string' ? req.query.peerId : '';
        if (!roomId || !peerId) {
            res.status(204).end();
            return;
        }
        (0, room_registry_1.markClosing)(roomId, peerId);
        const expectedSocketId = (0, room_registry_1.getPeerSocket)(roomId, peerId);
        const timer = setTimeout(() => {
            // A newer socket generation always wins over this stale beacon.
            if ((0, room_registry_1.getPeerSocket)(roomId, peerId) !== expectedSocketId)
                return;
            const activeSocket = expectedSocketId ? io.sockets.sockets.get(expectedSocketId) : undefined;
            if (activeSocket?.connected)
                return;
            (0, room_registry_1.evictPeer)(io, roomId, peerId, expectedSocketId);
        }, room_registry_1.CLOSE_GRACE_MS);
        (0, room_registry_1.scheduleEviction)(roomId, peerId, timer);
        // Ответ телу sendBeacon не важен — отвечаем сразу.
        res.status(204).end();
    });
    // ---------------------------------------------------------------------------
    // Фоновая подчистка осиротевших вложений (защита диска от утечки места).
    // Запускаем при старте и далее раз в час.
    // ---------------------------------------------------------------------------
    void (0, uploads_1.sweepOrphanUploads)();
    const sweepTimer = setInterval(() => {
        void (0, uploads_1.sweepOrphanUploads)();
    }, Math.min(config_1.UPLOAD_TTL_MS, 60 * 60 * 1000));
    sweepTimer.unref();
    // ---------------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------------
    httpServer.listen(config_1.PORT, () => {
        console.log(`[server] Replixo mediasoup server running on port ${config_1.PORT}`);
        console.log(`[server] CORS allowed origin: ${config_1.CLIENT_ORIGIN}`);
        console.log(`[server] Uploads dir: ${config_1.UPLOAD_DIR} (max ${Math.round(config_1.MAX_FILE_SIZE / 1024 / 1024)} MB/file)`);
    });
    // ---------------------------------------------------------------------------
    // Graceful shutdown
    // ---------------------------------------------------------------------------
    const shutdown = () => {
        console.log('[server] Shutting down...');
        clearInterval(sweepTimer);
        worker.close();
        httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((e) => {
    console.error('[server] Fatal error:', e);
    process.exit(1);
});
