"use strict";
// ---------------------------------------------------------------------------
// Файловые вложения чата на диске VPS.
//
// Все файлы лежат под UPLOAD_DIR в подпапке на комнату:
//   <UPLOAD_DIR>/<roomId>/<uuid>.<ext>
//
// Жизненный цикл = жизненный цикл комнаты: папка комнаты удаляется целиком,
// когда комната опустела и уничтожается (socket.ts → cleanupRoomIfEmpty).
// Фоновый сборщик (sweepOrphanUploads) подчищает папки, осиротевшие после
// жёсткого падения процесса, чтобы диск не тёк.
// ---------------------------------------------------------------------------
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidRoomId = isValidRoomId;
exports.roomUploadDir = roomUploadDir;
exports.ensureUploadRoot = ensureUploadRoot;
exports.ensureRoomDir = ensureRoomDir;
exports.deleteRoomUploads = deleteRoomUploads;
exports.sweepOrphanUploads = sweepOrphanUploads;
const fs_1 = __importDefault(require("fs"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
// roomId приходит из URL — строго ограничиваем символы, чтобы исключить выход
// за пределы UPLOAD_DIR (path traversal вроде "../../etc").
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isValidRoomId(roomId) {
    return ROOM_ID_RE.test(roomId);
}
/** Абсолютный путь к папке вложений конкретной комнаты. */
function roomUploadDir(roomId) {
    return path_1.default.join(config_1.UPLOAD_DIR, roomId);
}
/** Создать корневую папку загрузок, если её ещё нет. */
function ensureUploadRoot() {
    fs_1.default.mkdirSync(config_1.UPLOAD_DIR, { recursive: true });
}
/** Создать папку вложений комнаты (идемпотентно). */
function ensureRoomDir(roomId) {
    const dir = roomUploadDir(roomId);
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
/**
 * Удалить все вложения комнаты. Вызывается при уничтожении комнаты, чтобы файлы
 * стирались вместе с ней (без утечки места на диске). Fire-and-forget.
 */
async function deleteRoomUploads(roomId) {
    if (!isValidRoomId(roomId))
        return;
    try {
        await promises_1.default.rm(roomUploadDir(roomId), { recursive: true, force: true });
        console.log(`[uploads] Удалены вложения комнаты ${roomId}`);
    }
    catch (e) {
        console.error('[uploads] deleteRoomUploads failed:', e.message);
    }
}
/**
 * Подчистить осиротевшие папки: те, что не менялись дольше UPLOAD_TTL_MS.
 * Защита от утечки места на диске, если штатная очистка не отработала
 * (например, сервер был убит во время звонка). Активные комнаты не трогаются —
 * у них свежие файлы, mtime обновляется при каждой загрузке.
 */
async function sweepOrphanUploads() {
    let entries;
    try {
        entries = await promises_1.default.readdir(config_1.UPLOAD_DIR, { withFileTypes: true });
    }
    catch {
        return; // папки ещё нет — чистить нечего
    }
    const now = Date.now();
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path_1.default.join(config_1.UPLOAD_DIR, entry.name);
        try {
            const stat = await promises_1.default.stat(dir);
            if (now - stat.mtimeMs > config_1.UPLOAD_TTL_MS) {
                await promises_1.default.rm(dir, { recursive: true, force: true });
                console.log(`[uploads] Подчищена осиротевшая папка ${entry.name}`);
            }
        }
        catch {
            // Игнорируем — папку могли удалить параллельно.
        }
    }
}
