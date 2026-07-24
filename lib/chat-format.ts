// ---------------------------------------------------------------------------
// Форматирование, общее для чата комнаты (эфемерного) и личных сообщений.
//
// Вынесено из app/room/[roomId]/chat-helpers.ts: логика одинаковая, а зависеть
// от файла внутри роута комнаты личный чат не должен. Специфика комнаты
// (цвета имён по peerId, «прочитано всеми») осталась там.
// ---------------------------------------------------------------------------

/**
 * Минимальная форма вложения: и `ChatAttachment` комнаты, и `DmAttachment`
 * личного чата подходят структурно. Отдельный тип нужен, чтобы этот модуль не
 * тянул за собой ни mediasoup-типы, ни типы ЛС.
 */
export interface AttachmentLike {
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

export function isImageAttachment(a: AttachmentLike): boolean {
  return a.mime.startsWith('image/')
}
