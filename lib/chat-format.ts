// ---------------------------------------------------------------------------
// Форматирование, общее для эфемерного чата комнаты и личных сообщений.
//
// Вынесено из app/room/[roomId]/chat-helpers.ts без изменения поведения:
// оба чата показывают время и размер файла одинаково, дублировать логику
// незачем. Специфика комнаты (цвета имён, «прочитано всеми участниками»)
// осталась в chat-helpers.ts.
// ---------------------------------------------------------------------------

/**
 * Минимальная форма вложения: ровно то, что возвращает upload-эндпоинт и что
 * лежит в БД. Намеренно структурная (а не импорт типа комнаты), чтобы модуль
 * не зависел ни от mediasoup-хуков, ни от типов ЛС.
 */
export interface ChatAttachmentLike {
  url: string
  name: string
  size: number
  mime: string
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

export function isImageAttachment(a: ChatAttachmentLike): boolean {
  return a.mime.startsWith('image/')
}
