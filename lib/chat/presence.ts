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
//
// Две вещи, из-за которых этот путь раньше стоил секунду на каждое открытие
// кабинета:
//
//   • Запрос ЖДАЛ список друзей, чтобы передать их id. Два обращения к одной и
//     той же БД выстраивались в цепочку, хотя сокет-сервер и сам знает, кто с
//     кем дружит (и держит этот список в кэше). Теперь спрашиваем «статусы
//     друзей вот этого пользователя», и запрос уходит одновременно со списком.
//
//   • Без INTERNAL_HOOK_SECRET он не уходил вовсе и возвращал пустоту, а пустой
//     снапшот — это «не знаем», то есть «Подключение…» на КАЖДОЙ строке.
//     Незаданный секрет — состояние по умолчанию, поэтому теперь есть фолбэк:
//     lastSeenAt Next читает из Postgres сам (см. completePresence).
// ---------------------------------------------------------------------------

import { fetchLastSeen } from './last-seen'
import { serverBaseUrl } from './internal-url'

/** Статусов два: см. PresenceStatus в server/src/dm/presence.ts. */
export type PresenceStatus = 'online' | 'offline'

export interface PresenceSnapshot {
  /**
   * Ответил ли сокет-сервер. Пустой снапшот значит одно из двух — «никого нет в
   * сети» или «спросить не удалось», и различать их обязательно: в первом случае
   * про человека честно известно, что он оффлайн, во втором про него не известно
   * ничего, и рисовать «не в сети» нельзя (см. presenceLabel: 'unknown').
   *
   * Относится ТОЛЬКО к statuses. lastSeenAt может быть заполнен и при ok: false —
   * его Next читает из БД без всякого сокет-сервера.
   */
  ok: boolean
  /** userId → статус. Оффлайн не передаётся: это состояние по умолчанию. */
  statuses: Record<string, Exclude<PresenceStatus, 'offline'>>
  /** userId → когда его видели последний раз (мс). */
  lastSeenAt: Record<string, number>
}

export const EMPTY_PRESENCE: PresenceSnapshot = { ok: false, statuses: {}, lastSeenAt: {} }

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
    '[presence] INTERNAL_HOOK_SECRET не задан — статусы «в сети» в HTTP-ответах ' +
      'отключены (зелёные точки появятся только после подключения websocket). ' +
      'Время последнего присутствия читается из БД и работает без него.',
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

  return { ok: true, statuses: safeStatuses, lastSeenAt: safeLastSeen }
}

/**
 * Статусы и время последнего присутствия ДРУЗЕЙ указанного пользователя.
 *
 * Список друзей сюда не передаётся намеренно: его резолвит сокет-сервер, у
 * которого он уже лежит в кэше (friendIdsOf). Благодаря этому запрос можно
 * запустить одновременно с listFriends, а не после него — раньше два обращения к
 * одной БД шли цепочкой и складывали задержки.
 *
 * Никогда не бросает: presence — украшение поверх основных данных, и упавший
 * сокет-сервер не должен превращать список друзей в 500. В худшем случае
 * возвращается ok: false — тогда статусы дополнит completePresence и websocket.
 */
export async function fetchPresence(userId: string): Promise<PresenceSnapshot> {
  const secret = process.env.INTERNAL_HOOK_SECRET
  if (!secret) {
    warnMissingSecretOnce()
    return EMPTY_PRESENCE
  }

  try {
    const res = await fetch(`${serverBaseUrl()}/internal/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ ownerId: userId }),
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
 * Дополнить снапшот тем, что Next может узнать сам.
 *
 * Вызывается всегда, а не только при ok: false, и причина не в перестраховке.
 * Сокет-сервер отдаёт lastSeenAt для СВОЕГО представления о списке друзей, а
 * страница рисует своё — они разъезжаются на время кэша (FRIENDS_TTL_MS, 30 с),
 * и только что принятый друг оказался бы в списке без времени. Запрос по id из
 * страницы закрывает эту дыру и стоит один индексный SELECT.
 *
 * Значения сокет-сервера имеют приоритет: у него в памяти есть время, которое в
 * БД ещё не сброшено (запись троттлится, см. LAST_SEEN_FLUSH_MS).
 */
export async function completePresence(
  snapshot: PresenceSnapshot,
  friendIds: string[],
): Promise<PresenceSnapshot> {
  // Спрашивать не о ком — а значит и «не удалось спросить» тут не про что:
  // отдаём ok, иначе пустой список друзей навсегда остался бы в «Подключение…».
  if (friendIds.length === 0) return { ok: true, statuses: {}, lastSeenAt: {} }

  const missing = friendIds.filter((id) => snapshot.lastSeenAt[id] === undefined)
  if (missing.length === 0) return snapshot

  const fromDb = await fetchLastSeen(missing)
  return { ...snapshot, lastSeenAt: { ...fromDb, ...snapshot.lastSeenAt } }
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
