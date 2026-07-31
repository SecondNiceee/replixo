"use strict";
// ---------------------------------------------------------------------------
// Вложения личных чатов на диске VPS.
//
//   <UPLOAD_DIR>/dm/<conversationId>/<uuid><ext>
//
// Ключевое отличие от вложений комнаты: история ЛС постоянна, поэтому эти файлы
// живут столько же, сколько сообщения. Здесь НЕТ ни удаления по событию, ни
// TTL-сборщика — sweepOrphanUploads явно пропускает папку dm/ (см. ../uploads).
// ---------------------------------------------------------------------------
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidConversationId = isValidConversationId;
exports.dmUploadRoot = dmUploadRoot;
exports.dmConversationDir = dmConversationDir;
exports.ensureDmConversationDir = ensureDmConversationDir;
exports.dmUrlPrefix = dmUrlPrefix;
exports.isDmAttachmentUrl = isDmAttachmentUrl;
exports.allowDmUpload = allowDmUpload;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
// conversationId приходит из URL. Детерминированный id диалога выглядит как
// `direct:<userId>:<userId>`, поэтому двоеточие разрешено. Точка запрещена —
// это отсекает path traversal («..») на уровне формата, до любых join'ов.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
function isValidConversationId(value) {
    return typeof value === 'string' && CONVERSATION_ID_RE.test(value);
}
/** Корень вложений ЛС: <UPLOAD_DIR>/dm. */
function dmUploadRoot() {
    return path_1.default.join(config_1.UPLOAD_DIR, config_1.DM_UPLOAD_SUBDIR);
}
/** Абсолютный путь к папке вложений конкретного диалога. */
function dmConversationDir(conversationId) {
    return path_1.default.join(dmUploadRoot(), conversationId);
}
/** Создать папку вложений диалога (идемпотентно). */
function ensureDmConversationDir(conversationId) {
    const dir = dmConversationDir(conversationId);
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
/** Публичный префикс, под которым файлы диалога раздаёт express.static. */
function dmUrlPrefix(conversationId) {
    return `/uploads/${config_1.DM_UPLOAD_SUBDIR}/${conversationId}/`;
}
/**
 * Проверка, что ссылка на вложение указывает строго в папку ЭТОГО диалога.
 * Без неё клиент мог бы прислать в dm:send url на чужую переписку и получить
 * чужой файл, отрисованный как своё вложение.
 */
function isDmAttachmentUrl(url, conversationId) {
    return url.startsWith(dmUrlPrefix(conversationId)) && !url.includes('..');
}
// ---------------------------------------------------------------------------
// Rate limit загрузок: 20 файлов в минуту на пользователя.
//
// Считаем по userId, а не по сокету: у одного пользователя может быть несколько
// вкладок, и лимит должен быть общим. Загрузка идёт обычным HTTP-запросом, так
// что createRateLimiter (он рассчитан на одно соединение) здесь не подходит.
// ---------------------------------------------------------------------------
const UPLOAD_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60000;
const uploadHits = new Map();
function allowDmUpload(userId) {
    const now = Date.now();
    const fresh = (uploadHits.get(userId) ?? []).filter((ts) => now - ts < UPLOAD_WINDOW_MS);
    if (fresh.length >= UPLOAD_LIMIT) {
        // Записываем обрезанное окно, чтобы память не росла на отказах.
        uploadHits.set(userId, fresh);
        return false;
    }
    fresh.push(now);
    uploadHits.set(userId, fresh);
    return true;
}
// Периодически выбрасываем пользователей, которые давно ничего не загружали:
// иначе Map жила бы вечно и текла на длинной аптайм-сессии сервера.
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, hits] of uploadHits) {
        if (hits.every((ts) => now - ts >= UPLOAD_WINDOW_MS))
            uploadHits.delete(userId);
    }
}, UPLOAD_WINDOW_MS);
cleanupTimer.unref();
