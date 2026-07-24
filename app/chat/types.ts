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
  lastMessageAt: string | null
  lastMessageText: string | null
  lastMessageSenderId: string | null
}

export type DmMessageStatus = 'sending' | 'sent' | 'failed'

export interface DmMessage {
  id: string
  senderId: string
  text: string
  createdAt: number
  /** Локальный статус оптимистичной отправки. Отсутствует у истории из БД. */
  status?: DmMessageStatus
}

/** Сообщение в том виде, в каком его присылает сервер (сокет или HTTP). */
export interface RawDmMessage {
  id: string
  senderId: string
  text: string
  createdAt: string | number
}

export function normalizeMessage(raw: RawDmMessage): DmMessage {
  return {
    id: raw.id,
    senderId: raw.senderId,
    text: raw.text ?? '',
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
