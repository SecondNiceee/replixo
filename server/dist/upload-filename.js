"use strict";
// ---------------------------------------------------------------------------
// Починка «битых» имён файлов из multipart/form-data.
//
// multer 1.x (через busboy) читает имя файла в заголовке part'а как latin1.
// Браузеры же присылают его в UTF-8, поэтому кириллица приезжает мохибакой:
//   «Файл.pdf» → «Ð¤Ð°Ð¹Ð».pdf».
// Байты при этом не теряются: latin1 — однобайтовая кодировка, каждый байт
// становится code point 0..255. Значит достаточно собрать байты обратно и
// прочитать их как UTF-8.
//
// Делаем это осторожно: если имя уже пришло корректным UTF-8 (некоторые клиенты
// присылают RFC 2231/percent-encoded, а Node мог декодировать сам), повторное
// «исправление» его бы испортило. Поэтому переводим только строки, целиком
// состоящие из latin1-диапазона, и только если результат — валидный UTF-8.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeOriginalName = decodeOriginalName;
exports.safeAttachmentName = safeAttachmentName;
exports.contentDisposition = contentDisposition;
/** Строка целиком лежит в latin1 (каждый code point ≤ 0xFF)? */
function isLatin1Only(value) {
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) > 0xff)
            return false;
    }
    return true;
}
/**
 * Вернуть оригинальное имя файла в UTF-8.
 *
 * Идемпотентна: имя, которое уже корректно, возвращается без изменений.
 */
function decodeOriginalName(originalname) {
    if (!originalname)
        return originalname;
    // Уже есть символы вне latin1 → имя декодировано правильно, не трогаем.
    if (!isLatin1Only(originalname))
        return originalname;
    // Чистый ASCII → перекодировка ничего не изменит, экономим работу.
    // eslint-disable-next-line no-control-regex
    if (!/[\x80-\xff]/.test(originalname))
        return originalname;
    const bytes = Buffer.from(originalname, 'latin1');
    const decoded = bytes.toString('utf8');
    // U+FFFD означает, что байты не были валидным UTF-8 (например, имя реально
    // пришло в cp1251). В таком случае лучше оставить как есть, чем показать «».
    if (decoded.includes('\uFFFD'))
        return originalname;
    return decoded;
}
/**
 * Безопасное имя вложения для отдачи клиенту: сначала исправляем кодировку,
 * затем убираем путь и управляющие символы и ограничиваем длину.
 */
function safeAttachmentName(originalname) {
    const decoded = decodeOriginalName(originalname);
    const base = decoded.split(/[\\/]/).pop() ?? decoded;
    // eslint-disable-next-line no-control-regex
    const clean = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
    return (clean || 'file').slice(0, 255);
}
/**
 * Значение заголовка Content-Disposition для скачивания вложения.
 *
 * Имя приходит из query (?name=) — то есть от клиента, поэтому чистим его от
 * путей, кавычек и управляющих символов: заголовок нельзя дать «сломать»
 * переводом строки (header injection).
 *
 * Кириллицу в `filename=` положить нельзя — там разрешён только ASCII. Поэтому
 * даём два поля: ASCII-фолбэк для древних клиентов и `filename*` (RFC 5987,
 * UTF-8 percent-encoded), который понимают все актуальные браузеры.
 */
function contentDisposition(rawName) {
    const input = typeof rawName === 'string' ? rawName : '';
    const base = (input.split(/[\\/]/).pop() ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f"]/g, '')
        .trim()
        .slice(0, 255);
    if (!base)
        return 'attachment';
    // Фолбэк: всё не-ASCII заменяем на «_», иначе заголовок будет невалидным.
    // eslint-disable-next-line no-control-regex
    const ascii = base.replace(/[^\x20-\x7e]/g, '_');
    const encoded = encodeURIComponent(base);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
