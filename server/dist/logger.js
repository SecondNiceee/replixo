"use strict";
/**
 * Добавляет метку времени ко всем console-выводам сервера.
 *
 * Зачем: pm2 пишет server-out.log / server-error.log без дат (если процесс
 * запущен без флага `--time`), поэтому по логам невозможно понять, когда
 * произошёл дисконнект или ошибка. Здесь мы патчим console один раз при старте
 * процесса — все существующие console.log('[socket] ...') автоматически
 * получают префикс вида:
 *
 *   [2026-07-29 14:03:11.482 +03:00] [socket] Client connected: ...
 *
 * Часовой пояс берётся из LOG_TZ (по умолчанию Europe/Moscow), чтобы время
 * в логах совпадало с временем, о котором говорят пользователи.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.installTimestampedLogging = installTimestampedLogging;
const TZ = process.env.LOG_TZ || 'Europe/Moscow';
const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
});
function stamp() {
    const d = new Date();
    const f = {};
    for (const p of parts.formatToParts(d))
        f[p.type] = p.value;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    // longOffset даёт "GMT+03:00" -> оставляем "+03:00"
    const offset = (f.timeZoneName || '').replace('GMT', '') || 'Z';
    // hour может прийти как "24" при hour12: false в некоторых рантаймах
    const hour = f.hour === '24' ? '00' : f.hour;
    return `[${f.year}-${f.month}-${f.day} ${hour}:${f.minute}:${f.second}.${ms} ${offset}]`;
}
let installed = false;
function installTimestampedLogging() {
    if (installed)
        return;
    installed = true;
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    for (const m of methods) {
        const original = console[m].bind(console);
        console[m] = (...args) => original(stamp(), ...args);
    }
}
installTimestampedLogging();
