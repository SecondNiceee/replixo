'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { chatFetcher, type DmConversation } from '@/app/chat/types'

// ---------------------------------------------------------------------------
// Суммарное число непрочитанных сообщений — для бейджей вне страницы чата.
//
// Ключ SWR тот же, что у ChatClient, поэтому список диалогов не загружается
// повторно и оба места всегда показывают одно и то же число: погасив счётчик
// в открытом диалоге, ChatClient правит тот же кэш, а бейдж в шапке
// перерисовывается сам.
//
// Хук только читает: звук и заголовок вкладки — забота DmNotifier, ровно
// одного на приложение. Поэтому вызывать этот хук можно из любого числа
// компонентов.
// ---------------------------------------------------------------------------

export const CONVERSATIONS_KEY = '/api/chat/conversations'

export function useUnreadTotal(): number {
  const { socket, connected } = useDmSocket()
  const { data, mutate } = useSWR<{ conversations: DmConversation[] }>(
    CONVERSATIONS_KEY,
    chatFetcher,
  )

  // Живые обновления: новое сообщение меняет счётчик, чужое прочтение с
  // другого устройства — обнуляет. Без этого бейдж оживал бы только при
  // навигации или фокусе окна.
  useEffect(() => {
    if (!socket) return
    const revalidate = () => void mutate()
    socket.on('dm:message', revalidate)
    socket.on('dm:read', revalidate)
    return () => {
      socket.off('dm:message', revalidate)
      socket.off('dm:read', revalidate)
    }
  }, [socket, mutate])

  // Пока соединения не было, пропущенные сообщения могли не попасть в кэш.
  useEffect(() => {
    if (connected) void mutate()
  }, [connected, mutate])

  return (data?.conversations ?? []).reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)
}
