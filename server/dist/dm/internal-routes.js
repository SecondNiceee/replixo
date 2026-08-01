"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerInternalRoutes = registerInternalRoutes;
const crypto_1 = require("crypto");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const config_1 = require("../config");
const db_1 = require("./db");
const friends_events_1 = require("./friends-events");
// ---------------------------------------------------------------------------
// Внутренние маршруты «Next-сервер → сокет-сервер».
//
// Зачем: заявки в друзья пишет Next-API в Postgres, а этот процесс об изменении
// не узнаёт. Раньше о нём сообщал браузер инициатора через socket-событие — то
// есть realtime работал только когда у инициатора был живой websocket. Теперь
// основной путь идёт через сервер: Next-роут после успешного UPDATE дёргает
// POST /internal/friends/changed, и оба участника получают событие независимо от
// состояния клиентских соединений.
//
// Доступ: только по общему секрету в заголовке x-internal-secret. Секрет никогда
// не попадает в браузер (переменная без префикса NEXT_PUBLIC_), а сравнение —
// constant-time, чтобы по времени ответа его нельзя было подобрать побайтово.
// ---------------------------------------------------------------------------
function isAuthorized(req) {
    if (!config_1.INTERNAL_HOOK_SECRET)
        return false;
    const raw = req.header('x-internal-secret') ?? '';
    const a = Buffer.from(raw);
    const b = Buffer.from(config_1.INTERNAL_HOOK_SECRET);
    // timingSafeEqual требует равной длины, а сама длина секрета не тайна.
    if (a.length !== b.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(a, b);
}
const REASONS = [
    'requested',
    'accepted',
    'declined',
    'cancelled',
    'removed',
];
function isReason(value) {
    return typeof value === 'string' && REASONS.includes(value);
}
const MAX_ID_LENGTH = 64;
function isId(value) {
    return typeof value === 'string' && !!value && value.length <= MAX_ID_LENGTH;
}
// socket.io генерирует id из base64url-алфавита. Сужаем набор символов, потому
// что этот id используется как имя комнаты в `.except()`: имена наших комнат
// вида `user:<id>` содержат двоеточие, и без проверки клиент мог бы прислать
// «socket id», совпадающий с комнатой пользователя, и погасить рассылку целиком.
function isSocketId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
// ---------------------------------------------------------------------------
// Ограничение частоты запросов к /internal/*.
//
// Сокет-сервер слушает публичный порт, значит и этот маршрут доступен из
// интернета. Секрет его защищает, но без лимита никто не мешает перебирать
// значения заголовка тысячами запросов в секунду: constant-time сравнение
// спасает от утечки по времени, а не от нагрузки.
//
// Оба уровня считают ТОЛЬКО неудачные ответы (skipSuccessfulRequests).
//
// Раньше широкий уровень считал и успешные — 300 запросов в минуту. trust proxy
// не включён, поэтому req.ip у всех вызовов от Next одинаковый: это был не
// per-IP, а ГЛОБАЛЬНЫЙ потолок на все события дружбы в приложении. На 301-м
// хук получал 429, isRetriable(429) === false → notified: false → realtime
// молча уезжал на клиентский фолбэк. Деградация невидимая, а лимит бьёт по
// легальному трафику, который и есть цель этого маршрута.
//
// Успешный ответ здесь означает пройденную проверку секрета, то есть запрос от
// самих себя. Ограничивать его нечем: потолок на легальную нагрузку — это
// потолок на активность пользователей. Флуд с утёкшим секретом остаётся, но
// это задача уровня инфраструктуры (прокси/CDN), а не ведра по IP, которого в
// этом окружении фактически нет.
//
// Перебор же секрета состоит из одних 401 и глохнет:
//  1) BURST_LIMITER — быстрый срез: 10 неудач за 10 секунд, чтобы rapid-fire
//     обрывался сразу, а не выбирал весь пятиминутный бюджет.
//  2) FAILURE_LIMITER — длинное окно: 20 неудач за 5 минут против медленного
//     перебора «по чуть-чуть».
//
// Ключ задан константой явно: за прокси req.ip всё равно один для всех, и лучше
// честно считать неудачи глобально, чем делать вид, что лимит per-IP. Для
// неудачных ответов это ровно то поведение, которое нужно. Если однажды
// появится app.set('trust proxy') — здесь ничего не «оживёт» само собой,
// keyGenerator придётся менять осознанно.
// ---------------------------------------------------------------------------
/** Ведро одно на весь маршрут: см. комментарий выше про trust proxy. */
const failureKey = () => 'internal';
// Свой keyGenerator заодно снимает ip/trustProxy-проверки библиотеки: они
// выполняются только внутри дефолтного генератора ключа по req.ip.
const FAILURE_LIMITER = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    keyGenerator: failureKey,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
});
const BURST_LIMITER = (0, express_rate_limit_1.default)({
    windowMs: 10 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: failureKey,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
});
function registerInternalRoutes(app, io) {
    if (!config_1.INTERNAL_HOOK_SECRET) {
        console.warn('[internal] INTERNAL_HOOK_SECRET не задан — /internal/* отключён, ' +
            'realtime дружбы работает через фолбэк на socket-событии.');
    }
    // Лимиты навешиваем на весь префикс, а не на конкретный маршрут: любой
    // будущий /internal/* получит защиту автоматически, включая запросы к
    // несуществующим путям под этим префиксом: 404 — это неудачный ответ, значит
    // он попадает в лимит и перебор путей тоже глохнет.
    app.use('/internal', BURST_LIMITER, FAILURE_LIMITER);
    app.post('/internal/friends/changed', (req, res) => {
        void (async () => {
            if (!isAuthorized(req)) {
                // 503 без секрета и 401 при неверном: пусть Next-роут различает
                // «хук не настроен» и «настроен неправильно» — второе стоит починить.
                res.status(config_1.INTERNAL_HOOK_SECRET ? 401 : 503).json({ error: 'unauthorized' });
                return;
            }
            if (!(0, db_1.isDmEnabled)()) {
                res.status(503).json({ error: 'dm_disabled' });
                return;
            }
            const { userId, peerId, reason, notificationId, originSocketId } = (req.body ??
                {});
            if (!isId(userId) || !isId(peerId) || userId === peerId) {
                res.status(400).json({ error: 'bad_payload' });
                return;
            }
            if (!isReason(reason)) {
                res.status(400).json({ error: 'bad_reason' });
                return;
            }
            // Уведомление создаётся не для каждого события (отмена заявки и удаление
            // из друзей ничего не создают), поэтому поле опционально. Но если оно
            // пришло — это должен быть валидный id, иначе payload битый.
            if (notificationId != null && !isId(notificationId)) {
                res.status(400).json({ error: 'bad_notification_id' });
                return;
            }
            // Соединение-источник тоже опционально: действие могли выполнить вообще
            // без websocket (curl, второй браузер без чата). Значение приходит из
            // браузера, поэтому это не «доверенный» id: максимум, что им можно
            // сделать — исключить один сокет из рассылки И только внутри двух комнат
            // участников. Форму всё равно проверяем, чтобы в except() не улетала
            // произвольная строка-комната.
            if (originSocketId != null && !isSocketId(originSocketId)) {
                res.status(400).json({ error: 'bad_origin_socket_id' });
                return;
            }
            // Оба id приходят от доверенного Next-роута, но существование проверяем:
            // рассылать в комнату несуществующего пользователя незачем. Два запроса
            // независимы, поэтому идут параллельно — последовательный await удваивал
            // задержку хука на ровном месте.
            const [selfOk, peerOk] = await Promise.all([(0, db_1.userExists)(userId), (0, db_1.userExists)(peerId)]);
            if (!selfOk || !peerOk) {
                res.status(404).json({ error: 'user_not_found' });
                return;
            }
            const link = await (0, friends_events_1.broadcastFriendsChanged)(io.of('/dm'), userId, peerId, reason, typeof notificationId === 'string' ? notificationId : null, typeof originSocketId === 'string' ? originSocketId : null);
            res.json({ ok: true, status: link.status });
        })().catch((e) => {
            console.error('[internal] friends/changed failed:', e.message);
            if (!res.headersSent)
                res.status(500).json({ error: 'internal_error' });
        });
    });
}
