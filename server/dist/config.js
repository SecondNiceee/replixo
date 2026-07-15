"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webRtcTransportOptions = exports.mediaCodecs = exports.workerSettings = exports.iceServers = exports.listenIps = exports.UPLOAD_TTL_MS = exports.WINDOWS_INSTALLER_NAME = exports.WINDOWS_INSTALLER_PATH = exports.MAX_FILE_SIZE = exports.UPLOAD_DIR = exports.MAX_PEERS_PER_ROOM = exports.CLIENT_ORIGIN = exports.PORT = void 0;
require("dotenv/config");
const path_1 = __importDefault(require("path"));
// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
exports.PORT = parseInt(process.env.PORT ?? '3001', 10);
exports.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:3000';
exports.MAX_PEERS_PER_ROOM = 5;
// ---------------------------------------------------------------------------
// Вложения чата (файлы хранятся на диске VPS, без внешних blob-хранилищ)
// ---------------------------------------------------------------------------
// Корневая папка для вложений. Внутри — по подпапке на каждую комнату:
// <UPLOAD_DIR>/<roomId>/<uuid>.<ext>. Папка комнаты удаляется целиком, когда
// комната уничтожается (см. socket.ts → cleanupRoomIfEmpty).
exports.UPLOAD_DIR = process.env.UPLOAD_DIR ?? path_1.default.join(process.cwd(), 'uploads');
// Максимальный размер одного файла (байты). По умолчанию 25 МБ.
exports.MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE ?? String(25 * 1024 * 1024), 10);
// ---------------------------------------------------------------------------
// Установщик приложения (большой файл ~900 МБ, лежит на диске VPS, НЕ в git)
// ---------------------------------------------------------------------------
// Абсолютный путь к .exe-установщику для Windows. Файл кладётся на диск сервера
// вручную (через scp/rsync) и НЕ коммитится в репозиторий. Маршрут /download/windows
// отдаёт именно этот файл. По умолчанию ищем в <cwd>/downloads/Replixo-Setup-version-1.exe.
exports.WINDOWS_INSTALLER_PATH = process.env.WINDOWS_INSTALLER_PATH ??
    path_1.default.join(process.cwd(), 'downloads', 'Replixo-Setup-version-1.exe');
// Имя файла, под которым установщик будет сохранён у пользователя.
exports.WINDOWS_INSTALLER_NAME = process.env.WINDOWS_INSTALLER_NAME ?? 'Replixo-Setup-version-1.exe';
// Подстраховка от "осиротевших" файлов после жёсткого падения сервера (когда
// штатная очистка при уничтожении комнаты не успела отработать). Папки комнат,
// не изменявшиеся дольше этого срока, удаляются фоновым сборщиком. По умолчанию
// 48 часов — заведомо больше любого живого звонка.
exports.UPLOAD_TTL_MS = parseInt(process.env.UPLOAD_TTL_MS ?? String(48 * 60 * 60 * 1000), 10);
// ---------------------------------------------------------------------------
// WebRTC / ICE
// ---------------------------------------------------------------------------
const announcedIp = process.env.ANNOUNCED_IP ?? undefined;
exports.listenIps = [
    {
        ip: '0.0.0.0',
        announcedIp,
    },
];
// ICE servers sent to every WebRTC client.
//
// STUN alone is NOT enough for phone <-> PC calls: mobile carriers put phones
// behind symmetric NAT (CGNAT), which STUN cannot traverse. Without a TURN
// relay the media path silently fails and the remote person "can't be heard".
//
// We therefore ship the operator's own TURN relay. TURN_URL may be a single
// url or a comma-separated list (e.g. UDP + TCP/TLS variants of the same
// coturn instance). All entries share the same TURN_USERNAME / TURN_CREDENTIAL.
const customTurnUrls = (process.env.TURN_URL ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
const customTurn = customTurnUrls.length > 0
    ? customTurnUrls.map((urls) => ({
        urls,
        username: process.env.TURN_USERNAME ?? '',
        credential: process.env.TURN_CREDENTIAL ?? '',
    }))
    : [];
exports.iceServers = [
    { urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // The operator's own TURN relay (set via TURN_URL / TURN_USERNAME / TURN_CREDENTIAL).
    ...customTurn,
];
// ---------------------------------------------------------------------------
// Mediasoup Worker
// ---------------------------------------------------------------------------
exports.workerSettings = {
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
};
// ---------------------------------------------------------------------------
// Router media codecs
// ---------------------------------------------------------------------------
exports.mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        // Keep router capabilities neutral. Voice and screen-share music need
        // different DTX/bitrate settings, which are negotiated per producer.
        parameters: {
            'useinbandfec': 1,
            'maxplaybackrate': 48000,
        },
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
        },
    },
];
// ---------------------------------------------------------------------------
// WebRtcTransport options
// ---------------------------------------------------------------------------
exports.webRtcTransportOptions = {
    listenIps: exports.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // Start the bandwidth estimator high so screen shares are crisp from the
    // first second instead of ramping up from a blurry low-bitrate state.
    initialAvailableOutgoingBitrate: 6000000,
    minimumAvailableOutgoingBitrate: 300000,
    maxSctpMessageSize: 262144,
};
