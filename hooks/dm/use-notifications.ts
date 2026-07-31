'use client'

import { useCallback, useEffect } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import type { Socket } from 'socket.io-client'
import { chatFetcher } from '@/app/chat/types'

// ---------------------------------------------------------------------------
// Центр уведомлений: постоянный список + счётчик непрочитанных.
//
// Зачем поверх тостов. Тост живёт секунды и только при живом websocket: если
// получатель был офлайн или просто перезагрузил страницу, «вашу заявку приняли»
// исчезало бесследно. Теперь источник правды — таблица notification, а сокет
// лишь ускоряет доставку уже сохранённой записи.
//
// Ключ SWR один на приложение, поэтому бейдж в шапке и открытая панель читают
// один кэш: отметив прочитанным в панели, мы правим тот же объект, и бейдж
// гаснет сам, без второго запроса.
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_KEY = '/api/notifications'

export type AppNotificationKind = 'friend-request' | 'friend-accepted' | 'friend-declined'

export interface StoredNotification {
  id: string
  kind: AppNotificationKind
  actorId: string
  actorName: string
  read: boolean
  createdAt: number
}

interface NotificationsResponse {
  items: StoredNotification[]
  unread: number
}

export interface UseNotificationsResult {
  items: StoredNotification[]
  unread: number
  isLoading: boolean
  /** Отметить прочитанным одно уведомление (или все, без id). */
  markRead: (id?: string) => Promise<void>
  /** Удалить одно уведомление (или очистить всё, без id). */
  remove: (id?: string) => Promise<void>
}

/** Перечитать центр уведомлений из любого места (в том числе вне React). */
export function revalidateNotifications(): void {
  void globalMutate(NOTIFICATIONS_KEY)
}

/**
 * Список и счётчик. Вызывать можно из любого числа компонентов: ключ общий,
 * повторных запросов SWR не сделает.
 *
 * Подписку на сокет здесь НЕ навешиваем — этим владеет DmNotifier, ровно один
 * на приложение. Иначе панель и бейдж обрабатывали бы один `dm:notification`
 * дважды.
 */
export function useNotifications(): UseNotificationsResult {
  const { data, mutate, isLoading } = useSWR<NotificationsResponse>(
    NOTIFICATIONS_KEY,
    chatFetcher,
  )

  const items = data?.items ?? []
  const unread = data?.unread ?? 0

  const markRead = useCallback(
    async (id?: string) => {
      // Оптимистично гасим сразу: клик по уведомлению обычно уводит на другую
      // страницу, и ждать ответа сервера, чтобы бейдж обновился, поздно.
      void mutate(
        (current) =>
          current
            ? {
                items: current.items.map((n) =>
                  !id || n.id === id ? { ...n, read: true } : n,
                ),
                unread: id
                  ? Math.max(0, current.unread - (current.items.find((n) => n.id === id)?.read ? 0 : 1))
                  : 0,
              }
            : current,
        { revalidate: false },
      )

      const res = await fetch(`${NOTIFICATIONS_KEY}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id } : {}),
      }).catch(() => null)

      // Сервер возвращает честный счётчик (непрочитанное могло не попасть в
      // выданные 30 записей). Расходимся с оптимистичным значением — правим.
      if (res?.ok) {
        const { unread: fresh } = (await res.json()) as { unread: number }
        void mutate(
          (current) => (current ? { ...current, unread: fresh } : current),
          { revalidate: false },
        )
      } else {
        // Запрос не прошёл — оптимистичное состояние врёт, перечитываем.
        void mutate()
      }
    },
    [mutate],
  )

  const remove = useCallback(
    async (id?: string) => {
      void mutate(
        (current) =>
          current
            ? {
                items: id ? current.items.filter((n) => n.id !== id) : [],
                unread: id
                  ? Math.max(0, current.unread - (current.items.find((n) => n.id === id)?.read ? 0 : 1))
                  : 0,
              }
            : current,
        { revalidate: false },
      )

      const res = await fetch(NOTIFICATIONS_KEY, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id } : {}),
      }).catch(() => null)

      if (res?.ok) {
        const { unread: fresh } = (await res.json()) as { unread: number }
        void mutate(
          (current) => (current ? { ...current, unread: fresh } : current),
          { revalidate: false },
        )
      } else {
        void mutate()
      }
    },
    [mutate],
  )

  return { items, unread, isLoading, markRead, remove }
}

/**
 * Приём пушей уведомлений. Монтируется РОВНО ОДИН раз на приложение
 * (в DmNotifier) — иначе одно событие обработалось бы несколько раз.
 *
 * `onIncoming` вызывается для свежего уведомления: DmNotifier показывает по нему
 * тост и играет звук. Разделение намеренное: этот хук отвечает за состояние
 * (список + счётчик), а эффекты — забота вызывающего.
 */
export function useNotificationsRealtime(
  socket: Socket | null,
  onIncoming?: (n: StoredNotification) => void,
): void {
  useEffect(() => {
    if (!socket) return

    const onNotification = (payload: unknown) => {
      const { notification, unread } = (payload ?? {}) as {
        notification?: StoredNotification
        unread?: number
      }
      if (!notification?.id) return

      // Вставляем в кэш напрямую, без запроса: сервер прислал уже сохранённую
      // запись целиком, перечитывать список ради неё незачем.
      void globalMutate(
        NOTIFICATIONS_KEY,
        (current: NotificationsResponse | undefined) => {
          const rest = current?.items.filter((n) => n.id !== notification.id) ?? []
          return {
            items: [notification, ...rest],
            unread: unread ?? (current?.unread ?? 0) + 1,
          }
        },
        { revalidate: false },
      )

      onIncoming?.(notification)
    }

    // Пока соединения не было, пуши могли пройти мимо. Реконнект — единственный
    // момент, когда список гарантированно мог отстать от БД.
    const onConnect = () => revalidateNotifications()

    socket.on('dm:notification', onNotification)
    socket.on('connect', onConnect)
    return () => {
      socket.off('dm:notification', onNotification)
      socket.off('connect', onConnect)
    }
  }, [socket, onIncoming])
}
