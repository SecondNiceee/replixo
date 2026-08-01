'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'
import type { Socket } from 'socket.io-client'
import { CONVERSATIONS_KEY } from '@/hooks/dm/use-conversations'
import { revalidateNotifications } from '@/hooks/dm/use-notifications'
import { pushNotification } from '@/stores/notifications-store'
import { originSocketHeaders } from '@/lib/chat/origin-socket'

// ---------------------------------------------------------------------------
// Realtime-синхронизация дружбы.
//
// Заявки живут в Next-API (Postgres), а сокет-сервер — отдельный процесс: он не
// видит UPDATE в таблице friendship. Основной путь рассылки — серверный:
//
//   инициатор → HTTP в /api/friends/* → роут пишет в БД → роут сам дёргает
//   POST /internal/friends/changed на сокет-сервере → сервер рассылает
//   `dm:friends:changed` ОБОИМ участникам.
//
// Ключевое отличие от прежней схемы: рассылка не зависит от того, есть ли у
// инициатора живой websocket. Клиентский emit остался только фолбэком на случай
// «внутренний хук не настроен или недоступен» — роут сообщает об этом полем
// `notified: false` в ответе.
//
// Подписка одна на приложение (в DmNotifier), потому что ключи SWR глобальные:
// профиль читает те же '/api/friends' и обновляется сам, даже если открыт в
// другом месте дерева.
//
// Дедупликация эха — по СОЕДИНЕНИЮ, не по пользователю. Комната сокет-сервера
// адресуется по пользователю, поэтому событие получают все вкладки и устройства
// обоих участников. Гасить его по userId нельзя: обновилась только та вкладка,
// где кликнули, а остальные так и остались бы со старыми списками. Поэтому
// каждый мутирующий вызов идёт через `friendsAction` — он передаёт socket.id в
// заголовке, сервер исключает ровно этот сокет, а обработчик здесь дублирует
// проверку по `originSocketId` из payload.
// ---------------------------------------------------------------------------

/** Причина изменения. Совпадает с типом на сервере. */
export type FriendsChangeReason =
  | 'requested'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'removed'

/** Ключи SWR, зависящие от состояния дружбы. */
export const FRIENDS_KEYS = [
  '/api/friends',
  '/api/friends/pending',
  '/api/friends/sent',
] as const

const PENDING_KEYS = ['/api/friends/pending', '/api/friends/sent'] as const

/**
 * Перечитать списки, затронутые изменением.
 *
 * Причину используем, чтобы не дёргать все четыре эндпоинта на каждое событие:
 * заявка и её отклонение/отмена меняют только «входящие/исходящие», а список
 * друзей и список диалогов при этом остаются прежними. Без причины (реконнект,
 * когда события могли пройти мимо) перечитываем всё.
 */
export function revalidateFriends(reason?: FriendsChangeReason): void {
  runRevalidateFriends(touchesFriendList(reason))
}

/**
 * Затрагивает ли событие список друзей (а с ним и список диалогов).
 *
 * Без причины — да: это реконнект, за время которого могло произойти что угодно.
 */
function touchesFriendList(reason?: FriendsChangeReason): boolean {
  return !reason || reason === 'accepted' || reason === 'removed'
}

function runRevalidateFriends(wide: boolean): void {
  for (const key of wide ? FRIENDS_KEYS : PENDING_KEYS) {
    void mutate(key)
  }

  // Новый друг = новый возможный диалог, удалённый друг = недоступный.
  // Заявка и её отмена состав диалогов не меняют.
  if (wide) void mutate(CONVERSATIONS_KEY)
}

// ---------------------------------------------------------------------------
// Коалесинг ревалидаций для ВХОДЯЩИХ событий.
//
// `mutate(key)` дедупликацию SWR не использует — он принудительно перезапрашивает
// ключ. Поэтому серия событий подряд (человек разобрал десяток заявок, или кто-то
// гонит request/cancel в цикле) превращалась в 5 запросов на каждое событие.
// Лимит на роутах ограничил источник, но схлопнуть всплеск на приёме всё равно
// нужно: события могут прийти и от разных людей одновременно.
//
// Окно короткое и трейлинг: 200 мс задержки на чужое действие незаметны, зато
// десять событий внутри окна дают один набор запросов вместо десяти. Причины
// внутри окна объединяются по максимуму: если хоть одно событие затрагивало
// список друзей, перечитываем широкий набор ключей.
//
// Собственные действия (`notifyFriendsChanged` после ответа API) через планировщик
// НЕ идут: там пользователь ждёт результат своего клика и задержка была бы видна.
// ---------------------------------------------------------------------------

const COALESCE_MS = 200

let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingWide = false
let pendingNotifications = false

/**
 * Отложенная ревалидация с объединением событий, пришедших в одном окне.
 *
 * Экспортируется для тестов и на случай других источников событий; обычный путь
 * вызова — обработчик `dm:friends:changed`.
 */
export function scheduleFriendsRevalidation(
  reason?: FriendsChangeReason,
  notifications = false,
): void {
  pendingWide = pendingWide || touchesFriendList(reason)
  pendingNotifications = pendingNotifications || notifications

  // Таймер уже тикает — событие просто вливается в текущее окно.
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    const wide = pendingWide
    const notifications = pendingNotifications
    // Флаги сбрасываем ДО запросов: событие, пришедшее пока летят fetch'и,
    // должно открыть новое окно, а не потеряться в уже слитом.
    pendingWide = false
    pendingNotifications = false

    runRevalidateFriends(wide)
    if (notifications) revalidateNotifications()
  }, COALESCE_MS)
}

/** Ответ любого мутирующего роута дружбы: поле `notified` есть у всех. */
export interface FriendsActionResponse {
  notified?: boolean
  peerId?: string
  friendship?: { addresseeId?: string; requesterId?: string }
  error?: string
  [key: string]: unknown
}

/**
 * Результат вызова роута дружбы.
 *
 * `status` и `retryAfterSec` нужны вызывающему, чтобы объяснить провал: раньше
 * возвращались только `ok` и тело, поэтому 429 и «заявка не найдена» выглядели
 * для компонента одинаково — как молчаливое ничего.
 *
 * `status: 0` — запрос не дошёл до сервера (офлайн, обрыв, заблокированный
 * запрос). Отдельное значение, потому что реакция другая: сервер ничего не
 * сделал, повтор осмыслен.
 */
export interface FriendsActionResult {
  ok: boolean
  status: number
  /** Значение заголовка `Retry-After` (секунды) у ответа 429. */
  retryAfterSec: number | null
  data: FriendsActionResponse | null
}

/**
 * Единственный способ вызвать мутирующий роут дружбы из браузера.
 *
 * Существует ровно для того, чтобы заголовок `x-origin-socket-id` нельзя было
 * забыть: без него сокет-сервер не знает, ИЗ КАКОГО соединения пришло действие,
 * и `except()` в рассылке не срабатывает — инициирующая вкладка получает эхо
 * своего же действия и ревалидирует списки второй раз. Раньше каждый компонент
 * собирал fetch руками, и заголовок не уезжал ни с одного роута.
 *
 * `socket.id` есть только у подключённого сокета. Если его нет (соединение ещё
 * поднимается или чат недоступен) — заголовок просто не отправляется, и эхо
 * получают все вкладки инициатора. Лишняя ревалидация безобидна, потеря
 * обновления — нет.
 */
export async function friendsAction(
  socket: Socket | null,
  url: string,
  method: 'POST' | 'DELETE',
  body: Record<string, unknown>,
): Promise<FriendsActionResult> {
  // fetch отклоняется промисом только когда запрос не состоялся: офлайн, обрыв
  // соединения, отменённый запрос. Раньше исключение улетало наверх, а вызовы в
  // компонентах не обёрнуты в try/catch — вместе с падением терялся и
  // `setBusyId(null)`, так что кнопка оставалась в спиннере навсегда.
  try {
    return await runFriendsAction(socket, url, method, body)
  } catch {
    return { ok: false, status: 0, retryAfterSec: null, data: null }
  }
}

async function runFriendsAction(
  socket: Socket | null,
  url: string,
  method: 'POST' | 'DELETE',
  body: Record<string, unknown>,
): Promise<FriendsActionResult> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // socket.id читаем в момент запроса: после ре��оннекта он другой.
      ...originSocketHeaders(socket?.id),
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as FriendsActionResponse | null

  // Retry-After ставит наш лимитер (lib/chat/rate-limit) в секундах. Читаем
  // здесь, а не в компонентах: до тела ответа заголовок всё равно не доедет.
  const header = Number(res.headers.get('Retry-After'))
  const retryAfterSec = Number.isFinite(header) && header > 0 ? Math.ceil(header) : null

  return { ok: res.ok, status: res.status, retryAfterSec, data }
}

// ---------------------------------------------------------------------------
// Объяснение провала.
//
// Все три списка (входящие, исходящие, друзья) раньше на `!ok` не делали ничего:
// спиннер гаснет, строка на месте, причины нет. А доля неуспешных ответов тут
// не теоретическая: 429 от нашего же лимитера, 404 «заявка не найдена», если её
// отозвали пока страница висела открытой, 401 после истечения сессии.
// Пользователь видел просто неработающую кнопку.
// ---------------------------------------------------------------------------

/**
 * Статусы, означающие «страница показывает то, чего уже нет».
 *
 * 404 — заявку успели отозвать/принять с другого устройства, 409 — состояние
 * связи изменилось (уже друзья, заявка уже есть). В обоих случаях сервер прав,
 * а список устарел, и его нужно перечитать.
 */
function isStale(status: number): boolean {
  return status === 404 || status === 409
}

/**
 * Текст ошибки для пользователя.
 *
 * Сообщение сервера приоритетнее: роуты дружбы отвечают уже готовыми русскими
 * формулировками («Заявка не найдена», «Вы уже друзья»), и подменять их общей
 * фразой значит терять смысл. Свои тексты — только там, где сервер объяснить не
 * может (сеть) или где стоит добавить деталь (сколько ждать до повтора).
 */
export function friendsActionErrorMessage(result: FriendsActionResult): string {
  const fromServer = result.data?.error

  if (result.status === 0) return 'Нет связи с сервером. Проверьте подключение.'

  if (result.status === 429) {
    const wait = result.retryAfterSec
    return wait
      ? `Слишком много действий. Повторите через ${wait} с.`
      : (fromServer ?? 'Слишком много действий, попробуйте позже.')
  }

  if (result.status === 401) return 'Сессия истекла — войдите заново.'

  if (result.status >= 500) return 'Сервер недоступен. Попробуйте позже.'

  return fromServer ?? 'Не удалось выполнить действие.'
}

/**
 * Показать провал и, если причина в устаревших данных, перечитать списки.
 *
 * Тост, а не инлайновая ошибка в строке: строка после неудачи может исчезнуть
 * при ревалидации (её уже нет на сервере), и сообщение исчезло бы вместе с ней,
 * не успев прочитаться.
 */
export function reportFriendsActionError(result: FriendsActionResult): void {
  pushNotification({
    kind: 'error',
    title: 'Не получилось',
    body: friendsActionErrorMessage(result),
    // Склейка по виду: серия неудач подряд (лимит выдаёт 429 на каждый клик) не
    // должна выдавливать с экрана заявку в друзья или сообщение.
    dedupeKey: 'friends-error',
  })

  if (isStale(result.status)) {
    revalidateFriends()
    revalidateNotifications()
  }
}

/**
 * Обновить свои списки после успешного ответа API и, если серверный хук не
 * сработал, сообщить об изменении через сокет.
 *
 * `notified` — поле из ответа роута: `true` значит сокет-сервер уже разослал
 * событие обоим, и второй emit только удвоил бы работу. `false` приходит, когда
 * INTERNAL_HOOK_SECRET не задан или хук ответил ошибкой/таймаутом.
 */
export function notifyFriendsChanged(
  socket: Socket | null,
  peerId: string | undefined | null,
  reason: FriendsChangeReason,
  notified: boolean,
): void {
  // Свои списки обновляем всегда и сразу: полагаться на возврат собственного
  // события нельзя — сокета может не быть вовсе.
  revalidateFriends(reason)

  // Центр уведомлений — тоже наша забота, и именно здесь, а не в обработчике
  // `dm:friends:changed`. Эхо своего действия в эту вкладку не приходит вообще:
  // сервер исключает инициирующее соединение через `.except(originSocketId)`,
  // поэтому ветка с `scheduleFriendsRevalidation(reason, true)` для актора
  // недостижима — она обновляет центр только у ОСТАЛЬНЫХ соединений.
  //
  // Без этого вызова роут удалял запись из БД, а колокольчик у актора продолжал
  // её показывать до перезагрузки страницы: `accept`/`decline` удаляют свою
  // `friend-request`, `remove` — `friend-accepted`. Ровно та фантомная заявка,
  // что закрыта у получателя, но со стороны того, кто нажал кнопку.
  //
  // Сужать по причине нельзя по той же причине, что и в обработчике: центр
  // меняют все пять событий, а `requested` вдобавок должен погасить встречную
  // заявку, если она была.
  //
  // Планировщик здесь не используем: пользователь ждёт результат своего клика,
  // и 200 мс задержки на бейдже видны.
  revalidateNotifications()

  if (notified) return
  // Фолбэк: хук выключен или не дошёл. Собеседник узнает об изменении, только
  // если websocket есть у нас; иначе — при следующей загрузке страницы.
  if (!socket || !peerId) return
  socket.emit('dm:friends:changed', { peerId })
}

/**
 * Приём событий об изменении дружбы. Монтируется один раз на приложение.
 *
 * Дедупликац����я эха идёт по СОЕДИНЕНИЮ (`originSocketId` против `socket.id`), а
 * не по пользователю. Раньше стояло `if (userId === selfId) return`, и это был
 * баг мультидевайса: комната адресуется по пользователю (`user:<id>`), поэтому
 * событие приходит во все вкладки и на все устройства инициатора, но выбрасывали
 * его все — хотя списки перечитала только та вкладка, где кликнули. Второй таб и
 * телефон оставались с устаревшими данными до перезагрузки страницы.
 *
 * Гасить нужно ровно одно соединение — то, что уже обновилось по ответу API.
 * Сервер исключает его через `.except(originSocketId)`, а проверка здесь —
 * второй рубеж: она срабатывает, если рассылку сделал другой узел или сокет
 * успел переподключиться с новым id.
 *
 * Из-за этого хуку больше не нужен id пользователя: раньше он передавался только
 * ради `userId === selfId`, а по соединению всё решается без него.
 */
export function useFriendsRealtime(socket: Socket | null): void {
  // Первое подключение — не реконнект: SWR уже загрузил списки при монтировании,
  // и ревалидация здесь просто дублировала бы 4 запроса на каждый визит. Ref, а
  // не state: значение читается внутри обработчика и ререндер ему не нужен.
  const hasConnected = useRef(false)

  useEffect(() => {
    if (!socket) return

    const onChanged = (payload: unknown) => {
      const { peerId, reason, originSocketId } = (payload ?? {}) as {
        peerId?: string
        reason?: FriendsChangeReason
        originSocketId?: string | null
      }
      if (!peerId) return
      // Эхо ЭТОГО соединения — списки здесь уже перечитаны в notifyFriendsChanged
      // сразу после ответа API. Соседние вкладки того же пользователя приходят с
      // другим socket.id и обрабатываются как обычное ��обытие.
      if (originSocketId && socket.id && originSocketId === socket.id) return

      // Тост и центр уведомлений здесь НЕ трогаем: уведомление приходит
      // отдельным событием `dm:notification` уже сохранённым в БД (см.
      // useNotificationsRealtime). Единственное исключение — фолбэк-путь, когда
      // рассылку инициировал клиент: сервер в нём id уведомления не знает,
      // поэтому запись есть в БД, а пуша по ней не было. Перечитываем центр,
      // иначе бейдж отстанет до перезагрузки страницы.
      //
      // Сужать это условие по адресату (`peerId === selfId`) НЕЛЬЗЯ: центр
      // меняется не только у получателя. На `accept` инициатор удаляет свою же
      // запись `friend-request` — перечитать центр должен именно он, то есть
      // сторона, для которой `peerId !== selfId`. Поэтому ревалидируем у обоих.
      //
      // Сужать по причине тоже нельзя: центр меняют ВСЕ пять событий, причём
      // отзыв заявки и удаление из друзей — только удалением записи, без пуша.
      // Раньше здесь стоял список `requested|accepted|declined`, и это была
      // фантомная заявка: `cancel` удалял `friend-request` из БД, а у получателя
      // карточка и бейдж висели до перезагрузки и в��ли в пустые заявки. То же с
      // `remove` и записью `friend-accepted`.
      //
      // Списки и центр уведомлений уходят одним планировщиком, поэтому всплеск
      // событий даёт один набор запросов, а не по пять на каждое.
      scheduleFriendsRevalidation(reason, true)
    }

    // Пока соединения не было, события могли пройти мимо: после РЕКОННЕКТА
    // перечитываем всё, без сужения по причине. Самое первое подключение
    // пропускаем — данные только что пришли начальной загрузкой SWR.
    const onConnect = () => {
      if (!hasConnected.current) {
        hasConnected.current = true
        return
      }
      // Тоже через планировщик: при флаппинге сети reconnect может сработать
      // несколько раз подряд, и без окна это был бы залп запросов на каждый.
      // Центр уведомлений перечитываем вместе со списками — пуши, пришедшие
      // пока соединения не было, до нас не дошли.
      scheduleFriendsRevalidation(undefined, true)
    }

    // Сокет мог подключиться до того, как эффект успел навесить обработчик:
    // тогда 'connect' уже не придёт, и первый реальный реконнект был бы принят
    // за первое подключение и пропущен.
    if (socket.connected) hasConnected.current = true

    socket.on('dm:friends:changed', onChanged)
    socket.on('connect', onConnect)
    return () => {
      socket.off('dm:friends:changed', onChanged)
      socket.off('connect', onConnect)
    }
  }, [socket])
}
