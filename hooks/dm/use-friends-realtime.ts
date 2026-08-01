'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'
import type { Socket } from 'socket.io-client'
import { CONVERSATIONS_KEY } from '@/hooks/dm/use-conversations'
import { revalidateNotifications } from '@/hooks/dm/use-notifications'
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
  const touchesFriendList = !reason || reason === 'accepted' || reason === 'removed'

  for (const key of touchesFriendList ? FRIENDS_KEYS : PENDING_KEYS) {
    void mutate(key)
  }

  // Новый друг = новый возможный диалог, удалённый друг = недоступный.
  // Заявка и её отмена состав диалогов не меняют.
  if (touchesFriendList) void mutate(CONVERSATIONS_KEY)
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
): Promise<{ ok: boolean; data: FriendsActionResponse | null }> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // socket.id читаем в момент запроса: после реконнекта он другой.
      ...originSocketHeaders(socket?.id),
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as FriendsActionResponse | null
  return { ok: res.ok, data }
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

  if (notified) return
  // Фолбэк: хук выключен или не дошёл. Собеседник узнает об изменении, только
  // если websocket есть у нас; иначе — при следующей загрузке страницы.
  if (!socket || !peerId) return
  socket.emit('dm:friends:changed', { peerId })
}

/**
 * Приём событий об изменении дружбы. Монтируется один раз на приложение.
 *
 * Дедупликац��я эха идёт по СОЕДИНЕНИЮ (`originSocketId` против `socket.id`), а
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
      // другим socket.id и обрабатываются как обычное событие.
      if (originSocketId && socket.id && originSocketId === socket.id) return
      revalidateFriends(reason)

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
      // карточка и бейдж висели до перезагрузки и вели в пустые заявки. То же с
      // `remove` и записью `friend-accepted`.
      revalidateNotifications()
    }

    // Пока соединения не было, события могли пройти мимо: после РЕКОННЕКТА
    // перечитываем всё, без сужения по причине. Самое первое подключение
    // пропускаем — данные только что пришли начальной загрузкой SWR.
    const onConnect = () => {
      if (!hasConnected.current) {
        hasConnected.current = true
        return
      }
      revalidateFriends()
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
