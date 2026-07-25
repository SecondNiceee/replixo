// Формы данных личного чата на клиенте.
//
// Время всюду нормализовано в миллисекунды: HTTP-роуты отдают ISO-строку
// (drizzle timestamp), сокет — число. Приводим к одному виду при приёме,
// чтобы сортировка и сравнение не зависели от источника.

export interface DmConversation {
  id: string
  friendId: string
  friendName: string
  friendUsername: string | null
  unreadCount: number
  /** Маркер прочтения собеседника (ISO). Живые обновления идут через dm-store. */
  peerLastReadAt: string | null
  lastMessageAt: string | null
  lastMessageText: string | null
  /** jsonb последнего сообщения — для превью «Файл: …» в списке диалогов. */
  lastMessageAttachment?: unknown
  lastMessageSenderId: string | null
  /**
   * Удалено ли последнее сообщение (ISO). Нужно превью: тело такого сообщения
   * роут не отдаёт, и без этого признака в списке висело бы «Нет сообщений».
   */
  lastMessageDeletedAt?: string | null
}

/** Заглушка вместо тела удалённого сообщения — одна на ленту и на превью. */
export const DELETED_MESSAGE_TEXT = 'Сообщение удалено'

export type DmMessageStatus = 'sending' | 'sent' | 'failed'

/**
 * Вложение сообщения. `url` — относительный путь на mediasoup-сервере
 * (`/uploads/dm/<conversationId>/<uuid>.<ext>`); абсолютный адрес собирается
 * при рендере, поэтому смена домена сервера не ломает историю.
 */
export interface DmAttachment {
  url: string
  name: string
  size: number
  mime: string
}

export interface DmMessage {
  id: string
  senderId: string
  text: string
  attachment: DmAttachment | null
  createdAt: number
  /** Момент последней правки (мс) либо null — рисует пометку «изменено». */
  editedAt: number | null
  /** Момент удаления (мс) либо null. У удалённого тело не показываем. */
  deletedAt: number | null
  /** Локальный статус оптимистичной отправки. Отсутствует у истории из БД. */
  status?: DmMessageStatus
}

/** Сообщение в том виде, в каком его присылает сервер (сокет или HTTP). */
export interface RawDmMessage {
  id: string
  senderId: string
  text: string
  /** jsonb из БД — то есть на клиенте это `unknown` до проверки формы. */
  attachment?: unknown
  createdAt: string | number
  // Отсутствуют в payload сокета: у только что созданного сообщения правок и
  // удаления быть не может, поэтому поля опциональны.
  editedAt?: string | number | null
  deletedAt?: string | number | null
}

/**
 * Приведение вложения к известной форме. Столбец jsonb может содержать что
 * угодно (в том числе данные, записанные более старой версией кода), а рендер
 * обращается к полям напрямую — поэтому кривое значение превращаем в null,
 * а не пробрасываем в разметку.
 */
export function normalizeAttachment(raw: unknown): DmAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const { url, name, size, mime } = raw as Record<string, unknown>
  if (typeof url !== 'string' || !url) return null
  if (typeof name !== 'string' || !name) return null
  if (typeof mime !== 'string' || !mime) return null
  const safeSize = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0
  return { url, name, size: safeSize, mime }
}

/**
 * Метка времени к миллисекундам. Источники разные: HTTP отдаёт ISO-строку,
 * сокет — число, а необязательные поля приходят как null/undefined. Битую
 * строку приводим к null, иначе NaN просочился бы в сравнения и рендер.
 */
function toMillis(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = typeof value === 'number' ? value : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function normalizeMessage(raw: RawDmMessage): DmMessage {
  const deletedAt = toMillis(raw.deletedAt)
  return {
    id: raw.id,
    senderId: raw.senderId,
    // Тело удалённого сообщения не показываем. Роуты его и так не отдают, но
    // клиент не должен на это полагаться: одна пропущенная проверка на
    // сервере иначе сразу утекла бы в разметку.
    text: deletedAt ? '' : (raw.text ?? ''),
    attachment: deletedAt ? null : normalizeAttachment(raw.attachment),
    createdAt: toMillis(raw.createdAt) ?? Date.now(),
    editedAt: toMillis(raw.editedAt),
    deletedAt,
  }
}

export const chatFetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error('request failed')
    return r.json()
  })

export function conversationTitle(c: Pick<DmConversation, 'friendName' | 'friendUsername'>): string {
  return c.friendUsername ?? c.friendName
}

/**
 * Человекочитаемый статус оффлайн-собеседника. Точное время не показываем:
 * presence живёт в памяти сервера и после его перезапуска неизвестно, так что
 * формулировки намеренно расплывчатые.
 */
export function formatLastSeen(ts: number | undefined): string {
  if (!ts) return 'не в сети'
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'был(а) только что'
  if (minutes < 60) return `был(а) ${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `был(а) ${hours} ч назад`
  return 'был(а) давно'
}
