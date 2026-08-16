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
  /** Чат «Избранное» — заметки самому себе, виден только владельцу. */
  isSelf?: boolean
  /**
   * Строка есть в списке, но диалога в БД пока нет: «Избранное» создаётся
   * лениво, при первом открытии. См. ensureFavorites() в useConversations.
   */
  pending?: boolean
}

export const FAVORITES_TITLE = 'Избранное'
export const FAVORITES_HINT = 'Заметки только для вас'
export const FAVORITES_EMPTY_TEXT =
  'Здесь пока пусто. Сохраняйте заметки, ссылки и файлы — их видите только вы.'

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

export function conversationTitle(
  c: Pick<DmConversation, 'friendName' | 'friendUsername' | 'isSelf'>,
): string {
  // Отдельная ветка нужна и поиску по списку: он фильтрует по этому заголовку,
  // поэтому «Избранное» находится набором названия, а не своего юзернейма.
  if (c.isSelf) return FAVORITES_TITLE
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
 * После какой давности lastSeenAt САМ ПО СЕБЕ доказывает оффлайн.
 *
 * Нужен там, где статусы ещё не доехали (сокет-сервер недоступен или websocket
 * только поднимается), а время последнего присутствия уже известно из Postgres.
 * Держится это на том, как сокет-сервер пишет время (см. LAST_SEEN_FLUSH_MS в
 * server/src/dm/presence.ts): пока человек у экрана, значение обновляется не
 * реже раза в минуту. Значит время старше минуты с запасом означает, что за
 * последнюю минуту его онлайн никто не отмечал — то есть человека нет.
 *
 * Обратное неверно и поэтому здесь не используется: свежее время бывает и у
 * того, кто ушёл десять секунд назад (при разрыве время пишется принудительно).
 * Свежесть оставляет статус неизвестным, и такие строки честно ждут websocket —
 * но их единицы, а не весь список.
 *
 * 90 секунд — минутный период записи плюс запас на задержку UPDATE и расхождение
 * часов: занижать порог опаснее, чем завышать, ведь ошибка здесь означала бы
 * «не в сети» у человека, который на месте.
 */
export const LAST_SEEN_PROVES_OFFLINE_MS = 90_000

/**
 * Подпись под именем собеседника. Состояний два, и это не то же самое, что
 * «есть соединение / нет соединения»: живой websocket ещё не значит, что человек
 * за компьютером, поэтому свёрнутая вкладка подписывается «был(а) в сети только
 * что» — так подпись отвечает на настоящий вопрос «ответят ли мне сейчас».
 *
 * Промежуточного «отошёл(ла)» здесь больше нет: молчание за открытой вкладкой
 * ничего не доказывает, а подпись обещала бы отсутствие человеку, который просто
 * читает (см. шапку server/src/dm/presence.ts).
 */
export function presenceLabel(
  status: PresenceStatus,
  lastSeenAt: number | undefined,
  now?: number,
): string {
  // 'unknown' — это про нас, а не про человека: статус ещё не доехал. Раньше
  // такое состояние подписывалось «не в сети», и на первом кадре кабине��а
  // подпись мигала оффлайном у людей, которые в сети.
  if (status === 'unknown') return 'Подключение…'
  if (status === 'online') return 'в сети'
  return formatLastSeen(lastSeenAt, now)
}
