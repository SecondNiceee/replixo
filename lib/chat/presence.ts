// ---------------------------------------------------------------------------
// Чтение и правка presence из Next: запросы «сервер → сервер» к /internal/*.
//
// Только для серверного кода: читает INTERNAL_HOOK_SECRET (без префикса
// NEXT_PUBLIC_), из client-компонентов импортировать нельзя.
//
// Почему статусы вообще нужны по HTTP, если есть websocket: снапшот presence
// приходит только ПОСЛЕ подключения сокета, а список друзей рисуется сразу по
// ответу /api/friends. Без этих данных первый кадр показывал всех «не в сети»,
// и точки «доезжали» через полсекунды — заметное мигание на каждой навигации.
//
// Источник истины у двух половин ответа разный (см. server/src/dm/presence.ts):
// статус online живёт в памяти сокет-сервера, lastSeenAt — в Postgres.
// Спросить их одним запросом можно только у сокет-сервера, поэтому ходим туда.
// ---------------------------------------------------------------------------

import { serverBaseUrl } from './internal-url'

/** Статусов два: см. PresenceStatus в server/src/dm/presence.ts. */
export type PresenceStatus = 'online' | 'offline'

export interface PresenceSnapshot {
  /** userId → статус. Оффлайн не передаётся: это состояние по умолчанию. */
  statuses: Record<string, Exclude<PresenceStatus, 'offline'>>
  /** userId → когда его видели последний раз (мс). */
  lastSeenAt: Record<string, number>
}

export const EMPTY_PRESENCE: PresenceSnapshot = { statuses: {}, lastSeenAt: {} }

/**
 * Список друзей не должен ждать сокет-сервер: запрос локальный, поэтому щедрый
 * таймаут здесь означал бы только одно — что при перезапуске сокет-сервера
 * кабинет открывается на секунду дольше. Точки в этом случае доедут по
 * websocket, как и раньше.
 */
const TIMEOUT_MS = 500

let missingSecretWarned = false

function warnMissingSecretOnce(): void {
  if (missingSecretWarned) return
  missingSecretWarned = true
  console.warn(
    '[presence] INTERNAL_HOOK_SECRET не задан — статусы в HTTP-ответах отключены. ' +
      'Точки «в сети» появятся только после подключения websocket.',
  )
}

/** Разобрать ответ сокет-сервера, отбросив всё, что не той формы. */
function parseSnapshot(raw: unknown): PresenceSnapshot {
  if (!raw || typeof raw !== 'object') return EMPTY_PRESENCE
  const { statuses, lastSeenAt } = raw as Record<string, unknown>

  const safeStatuses: PresenceSnapshot['statuses'] = {}
  if (statuses && typeof statuses === 'object') {
    for (const [id, value] of Object.entries(statuses as Record<string, unknown>)) {
      // 'idle' мог прийти от ещё не перезапущенного сокет-сервера: статус
      // означал присутствие, поэтому и трактуем его как 'online', а не как мусор.
      if (value === 'online' || value === 'idle') safeStatuses[id] = 'online'
    }
  }

  const safeLastSeen: Record<string, number> = {}
  if (lastSeenAt && typeof lastSeenAt === 'object') {
    for (const [id, value] of Object.entries(lastSeenAt as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) safeLastSeen[id] = value
    }
  }

  return { statuses: safeStatuses, lastSeenAt: safeLastSeen }
}

/**
 * Статусы и время последнего присутствия для списка пользователей.
 *
 * Никогда не бросает: presence — украшение поверх основных данных, и упавший
 * сокет-сервер не должен превращать список друзей в 500. В худшем случае
 * возвращается пустой снапшот, а клиент дождётся статусов по websocket.
 */
export async function fetchPresence(userIds: string[]): Promise<PresenceSnapshot> {
  if (userIds.length === 0) return EMPTY_PRESENCE

  const secret = process.env.INTERNAL_HOOK_SECRET
  if (!secret) {
    warnMissingSecretOnce()
    return EMPTY_PRESENCE
  }

  try {
    const res = await fetch(`${serverBaseUrl()}/internal/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ userIds }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[presence] /internal/presence вернул ${res.status}`)
      return EMPTY_PRESENCE
    }
    return parseSnapshot(await res.json())
  } catch (e) {
    console.error('[presence] сокет-сервер недоступен:', (e as Error).message)
    return EMPTY_PRESENCE
  }
}

/**
 * Сообщить, что вкладка закрывается: снять её соединение с учёта немедленно.
 *
 * Личность здесь уже проверена вызывающим роутом — браузеру этот путь не
 * доверяют, иначе одним запросом можно было бы «выключить» любого пользователя.
 *
 * Возвращает признак доставки только для лога: ответ beacon'у всё равно никто
 * не читает, страница в этот момент уже выгружается.
 */
export async function reportPresenceLeave(
  userId: string,
  socketId: string,
): Promise<boolean> {
  const secret = process.env.INTERNAL_HOOK_SECRET
  if (!secret) {
    warnMissingSecretOnce()
    return false
  }

  try {
    const res = await fetch(`${serverBaseUrl()}/internal/presence/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ userId, socketId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) return true
    console.error(`[presence] /internal/presence/leave вернул ${res.status}`)
    return false
  } catch (e) {
    // Не страшно: движок Socket.IO заметит разрыв сам, просто позже.
    console.error('[presence] leave не доставлен:', (e as Error).message)
    return false
  }
}
