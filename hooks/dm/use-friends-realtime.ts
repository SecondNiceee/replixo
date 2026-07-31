'use client'

import { useEffect } from 'react'
import { mutate } from 'swr'
import type { Socket } from 'socket.io-client'
import { CONVERSATIONS_KEY } from '@/hooks/dm/use-conversations'

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
 * `selfId` нужен для дедупликации: инициатор действия получает своё же событие
 * эхом, но списки он уже перечитал в notifyFriendsChanged сразу после ответа
 * API. Без этой проверки каждое действие давало бы две волны ревалидации.
 */
export function useFriendsRealtime(socket: Socket | null, selfId: string): void {
  useEffect(() => {
    if (!socket) return

    const onChanged = (payload: unknown) => {
      const { peerId, userId, reason } = (payload ?? {}) as {
        peerId?: string
        userId?: string
        reason?: FriendsChangeReason
      }
      if (!peerId) return
      // Эхо собственного действия — уже обработано локально.
      if (userId === selfId) return
      revalidateFriends(reason)
    }

    // Пока соединения не было, события могли пройти мимо: после реконнекта
    // перечитываем всё, без сужения по причине.
    const onConnect = () => revalidateFriends()

    socket.on('dm:friends:changed', onChanged)
    socket.on('connect', onConnect)
    return () => {
      socket.off('dm:friends:changed', onChanged)
      socket.off('connect', onConnect)
    }
  }, [socket, selfId])
}
