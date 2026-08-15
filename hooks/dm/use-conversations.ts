'use client'

import { useCallback, useEffect } from 'react'
import useSWR from 'swr'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { chatFetcher, type DmConversation } from '@/app/chat/types'

// ---------------------------------------------------------------------------
// Единый источник правды по списку диалогов.
//
// Ключ SWR один на всё приложение, поэтому страница чата и бейджи вне неё
// читают один и тот же кэш: погасив счётчик в открытом диалоге, страница
// правит тот же объект, и бейдж в шапке перерисовывается сам, без второго
// запроса.
//
// Хук намеренно не играет звук и не трогает заголовок вкладки — этим владеет
// DmNotifier, ровно один на приложение. Поэтому вызывать хук можно из любого
// числа компонентов.
// ---------------------------------------------------------------------------

export const CONVERSATIONS_KEY = '/api/chat/conversations'

type ConversationsResponse = { conversations: DmConversation[] }

export type UseConversationsResult = {
  conversations: DmConversation[]
  isLoading: boolean
  totalUnread: number
  /** Перечитать список с сервера. */
  refresh: () => void
  /** Локально обнулить счётчик, ничего не записывая на сервер. */
  zeroUnreadLocally: (conversationId: string) => void
  /** Перечитать список, удержав счётчик диалога на нуле. */
  refreshKeepingRead: (conversationId: string) => void
  /** Создать (или найти) диалог с другом, вернуть его id. */
  startWithFriend: (friendId: string) => Promise<string | null>
  /**
   * Завести в БД чат «Избранное» и вернуть его id. Идемпотентно, поэтому
   * повторные вызовы безопасны.
   */
  ensureFavorites: () => Promise<string | null>
  /** Аварийная отметка прочтения по HTTP — только когда сокета нет. */
  markReadFallback: (conversationId: string) => Promise<void>
}

/**
 * Сокет берётся из useDmSocket — он refcount-шареный, поэтому вызывать этот
 * хук можно из любого числа компонентов: лишних websocket-соединений не будет.
 *
 * @param selfId Нужен, чтобы отличать своё прочтение с другого устройства от
 *   прочтения собеседника. Без него `dm:read` инвалидировал бы список на
 *   каждую чужую галочку.
 * @param activeId Открытый диалог. Сообщения в него не должны поднимать
 *   счётчик, пока вкладка видима.
 */
export function useConversations(
  selfId?: string,
  activeId?: string | null,
): UseConversationsResult {
  const { socket, connected } = useDmSocket()
  const { data, mutate, isLoading } = useSWR<ConversationsResponse>(
    CONVERSATIONS_KEY,
    chatFetcher,
  )

  const conversations = data?.conversations ?? []

  const refresh = useCallback(() => {
    void mutate()
  }, [mutate])

  // Бейдж и заголовок вкладки должны реагировать мгновенно. Авторитетную
  // запись делает useDmRead через сокет (и только когда это честно — вкладка
  // видима и лента доскроллена вниз), а это занимает как минимум дебаунс.
  const zeroUnreadLocally = useCallback(
    (conversationId: string) => {
      void mutate(
        (current) =>
          current
            ? {
                conversations: current.conversations.map((c) =>
                  c.id === conversationId ? { ...c, unreadCount: 0 } : c,
                ),
              }
            : current,
        { revalidate: false },
      )
    },
    [mutate],
  )

  // В БД счётчик ещё не обнулён (сокетная отметка в пути), поэтому свежий
  // ответ сервера принесёт старое число и бейдж мигнёт. Затираем его вручную.
  const refreshKeepingRead = useCallback(
    (conversationId: string) => {
      void mutate(
        async () => {
          const fresh = (await chatFetcher(CONVERSATIONS_KEY)) as ConversationsResponse
          return {
            conversations: fresh.conversations.map((c) =>
              c.id === conversationId ? { ...c, unreadCount: 0 } : c,
            ),
          }
        },
        { revalidate: false },
      )
    },
    [mutate],
  )

  const startWithFriend = useCallback(
    async (friendId: string): Promise<string | null> => {
      const res = await fetch(CONVERSATIONS_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendId }),
      })
      if (!res.ok) return null
      const { conversationId } = (await res.json()) as { conversationId: string }
      await mutate()
      return conversationId
    },
    [mutate],
  )

  const ensureFavorites = useCallback(async (): Promise<string | null> => {
    const res = await fetch(CONVERSATIONS_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ self: true }),
    })
    if (!res.ok) return null
    const { conversationId } = (await res.json()) as { conversationId: string }
    // Перечитываем список, чтобы синтетическая строка (pending) сменилась
    // настоящей: до этого сокет не пустил бы в диалог отправку сообщения.
    await mutate()
    return conversationId
  }, [mutate])

  // Этот роут не рассылает dm:read, поэтому вторые галочки у собеседника
  // появятся лишь после его перезагрузки. Основной путь — сокет (useDmRead).
  const markReadFallback = useCallback(
    async (conversationId: string) => {
      await fetch(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/read`,
        { method: 'POST' },
      ).catch(() => undefined)
      void mutate()
    },
    [mutate],
  )

  // Живые обновления. Отметку «прочитано» здесь НЕ ставим: этим занимается
  // useDmRead через сокет — только он даёт собеседнику вторые галочки и только
  // он знает, доскроллен ли пользователь до низа ленты.
  useEffect(() => {
    if (!socket) return

    const onMessage = (payload: unknown) => {
      const { conversationId } = (payload ?? {}) as { conversationId?: string }
      const visible = document.visibilityState === 'visible'

      // Диалог открыт и на виду — обновляем превью, но бейдж держим на нуле
      // до подтверждения сокетом.
      if (conversationId && activeId && conversationId === activeId && visible) {
        refreshKeepingRead(conversationId)
        return
      }
      void mutate()
    }

    // Прочтение с другого устройства обнуляет счётчик в БД — список должен это
    // увидеть. Если selfId не передан, инвалидируем на любое прочтение.
    const onRead = (payload: unknown) => {
      const { userId } = (payload ?? {}) as { userId?: string }
      if (!selfId || userId === selfId) void mutate()
    }

    socket.on('dm:message', onMessage)
    socket.on('dm:read', onRead)
    return () => {
      socket.off('dm:message', onMessage)
      socket.off('dm:read', onRead)
    }
  }, [socket, mutate, activeId, refreshKeepingRead, selfId])

  // Пока соединения не было, пропущенные сообщения могли не попасть в кэш.
  // Плюс стор эфемерного состояния очищается при разрыве (useDmPresence делает
  // reset), поэтому живой peerReadAt теряется. После реконнекта перечитываем
  // список — в нём есть peerLastReadAt из БД, и галочки восстанавливаются, а не
  // откатываются к одной.
  useEffect(() => {
    if (connected) void mutate()
  }, [connected, mutate])

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)

  return {
    conversations,
    isLoading,
    totalUnread,
    refresh,
    zeroUnreadLocally,
    refreshKeepingRead,
    startWithFriend,
    ensureFavorites,
    markReadFallback,
  }
}
