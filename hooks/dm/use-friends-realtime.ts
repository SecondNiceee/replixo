'use client'

import { useEffect } from 'react'
import { mutate } from 'swr'
import type { Socket } from 'socket.io-client'
import { CONVERSATIONS_KEY } from '@/hooks/dm/use-conversations'

// ---------------------------------------------------------------------------
// Realtime-синхронизация дружбы.
//
// Заявки живут в Next-API (Postgres), а сокет-сервер — отдельный процесс: он не
// видит UPDATE в таблице friendship. Поэтому схема такая:
//
//   инициатор действия → HTTP в /api/friends/* → успех →
//   notifyFriendsChanged(socket, peerId) → сервер перечитывает статус из БД и
//   рассылает `dm:friends:changed` ОБОИМ участникам → каждый клиент перечитывает
//   свои списки.
//
// Подписка одна на приложение (в DmNotifier), потому что ключи SWR глобальные:
// профиль читает те же '/api/friends' и обновляется сам, даже если открыт в
// другом месте дерева.
// ---------------------------------------------------------------------------

/** Ключи SWR, зависящие от состояния дружбы. */
export const FRIENDS_KEYS = [
  '/api/friends',
  '/api/friends/pending',
  '/api/friends/sent',
] as const

export function revalidateFriends(): void {
  for (const key of FRIENDS_KEYS) void mutate(key)
  // Новый друг = новый возможный диалог, удалённый друг = недоступный.
  void mutate(CONVERSATIONS_KEY)
}

/**
 * Сообщить серверу, что связь с `peerId` изменилась. Вызывать ПОСЛЕ успешного
 * ответа API: сервер читает фактический статус из БД, поэтому порядок важен.
 *
 * Сокета может не быть (чат недоступен, соединение поднимается) — тогда просто
 * обновляем свои списки локально, а собеседник увидит изменение при следующей
 * загрузке. Это деградация, а не ошибка.
 */
export function notifyFriendsChanged(socket: Socket | null, peerId: string | undefined | null): void {
  revalidateFriends()
  if (!socket || !peerId) return
  socket.emit('dm:friends:changed', { peerId })
}

/** Приём событий об изменении дружбы. Монтируется один раз на приложение. */
export function useFriendsRealtime(socket: Socket | null): void {
  useEffect(() => {
    if (!socket) return

    const onChanged = (payload: unknown) => {
      const { peerId } = (payload ?? {}) as { peerId?: string }
      if (!peerId) return
      revalidateFriends()
    }

    // Пока соединения не было, события могли пройти мимо: после реконнекта
    // списки перечитываем целиком.
    const onConnect = () => revalidateFriends()

    socket.on('dm:friends:changed', onChanged)
    socket.on('connect', onConnect)
    return () => {
      socket.off('dm:friends:changed', onChanged)
      socket.off('connect', onConnect)
    }
  }, [socket])
}
