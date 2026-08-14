import type { PresenceStatus } from '@/stores/dm-store'

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
}

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

export function normalizeMessage(raw: RawDmMessage): DmMessage {
  return {
    id: raw.id,
    senderId: raw.senderId,
    text: raw.text ?? '',
    attachment: normalizeAttachment(raw.attachment),
    createdAt:
      typeof raw.createdAt === 'number'
        ? raw.createdAt
        : new Date(raw.createdAt).getTime(),
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
 * Человекочитаемое «был(а) N назад».
 *
 * `now` передаётся аргументом, а не берётся из Date.now() внутри: строку нужно
 * обновлять по тику (см. useNow), а чистая функция от времени делает это
 * предсказуемым — тот же вход даёт тот же текст.
 *
 * Формулировки округлены до минут и часов: точное время присутствия никому не
 * нужно, а «был(а) 3 мин назад» читается быстрее любой даты.
 */
export function formatLastSeen(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) return 'не в сети'

  const minutes = Math.floor((now - ts) / 60_000)
  // Часы клиента могут немного опережать серверные — отрицательную разницу
  // показываем как «только что», а не как «был(а) -1 мин назад».
  if (minutes < 1) return 'был(а) только что'
  if (minutes < 60) return `был(а) ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `был(а) ${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`

  const days = Math.floor(hours / 24)
  if (days < 7) return `был(а) ${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  return 'был(а) давно'
}

/** Русские числительные: 1 минуту, 2 минуты, 5 минут. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = n % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/**
 * Подпись под именем собеседника. Три состояния вместо «в сети / не в сети»:
 * живой websocket ещё не значит, что человек за компьютером, поэтому отошедшего
 * подписываем отдельно — иначе зелёная точка обещала бы быстрый ответ.
 */
export function presenceLabel(
  status: PresenceStatus,
  lastSeenAt: number | undefined,
  now?: number,
): string {
  if (status === 'online') return 'в сети'
  // У отошедшего время последнего действия есть, но показывать его незачем:
  // соединение живо, сообщение он получит — важно лишь, что ответит не сразу.
  if (status === 'idle') return 'отошёл(ла)'
  return formatLastSeen(lastSeenAt, now)
}
