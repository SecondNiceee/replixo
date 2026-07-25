'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useDmPresence } from '@/hooks/dm/use-dm-presence'
import { useConversations } from '@/hooks/dm/use-conversations'
import { useDmStore } from '@/stores/dm-store'
import type { Friend } from '@/app/profile/types'
import { ConversationList } from './conversation-list'
import { ConversationView } from './conversation-view'
import { chatFetcher } from './types'

export function ChatClient({ selfId }: { selfId: string }) {
  const { socket, connected, unavailable } = useDmSocket()
  const searchParams = useSearchParams()

  // Единственный на приложение подписчик на эфемерные события: presence,
  // «печатает…», прочтение собеседника. Без него точки «в сети», индикатор
  // набора и вторые галочки не работают.
  useDmPresence(socket, selfId)

  const [activeId, setActiveId] = useState<string | null>(null)

  // Список диалогов, счётчики и все мутации живут в useConversations: тот же
  // SWR-ключ читают бейджи вне этой страницы, поэтому число непрочитанных
  // всегда совпадает.
  const {
    conversations,
    isLoading,
    totalUnread,
    zeroUnreadLocally,
    startWithFriend,
    markReadFallback,
  } = useConversations(selfId, activeId)

  const { data: friendsData } = useSWR<{ friends: Friend[] }>('/api/friends', chatFetcher)
  const friends = friendsData?.friends ?? []

  const active = conversations.find((c) => c.id === activeId) ?? null

  // Сообщаем глобальному уведомителю, какой диалог открыт: он монтируется вне
  // этой страницы и о локальном activeId ничего не знает, а без этого играл бы
  // звук по сообщениям из диалога, который пользователь и так видит.
  const setActiveConversationId = useDmStore((s) => s.setActiveConversationId)
  useEffect(() => {
    setActiveConversationId(activeId)
    // При уходе со страницы чата активного диалога больше нет — иначе
    // уведомитель продолжал бы считать его открытым и молчал бы.
    return () => setActiveConversationId(null)
  }, [activeId, setActiveConversationId])

  const openConversation = useCallback(
    (conversationId: string) => {
      setActiveId(conversationId)
      zeroUnreadLocally(conversationId)
    },
    [zeroUnreadLocally],
  )

  // Глубокая ссылка ?c=<id> (кнопка «Написать» из профиля).
  useEffect(() => {
    const fromUrl = searchParams.get('c')
    if (fromUrl) setActiveId(fromUrl)
  }, [searchParams])

  // Создать диалог и сразу открыть его. Обёртка над startWithFriend из хука:
  // сам хук об активном диалоге ничего не знает.
  const openWithFriend = useCallback(
    async (friendId: string) => {
      const conversationId = await startWithFriend(friendId)
      if (conversationId) openConversation(conversationId)
    },
    [startWithFriend, openConversation],
  )

  // Глубокая ссылка ?u=<friendId> (кнопка «Написать» в списке друзей).
  // В отличие от ?c=, диалога в БД может ещё не быть, поэтому идём через
  // startWithFriend: он создаёт его при необходимости и только потом
  // открывает. Иначе пользователь увидел бы пустой экран «Выберите диалог».
  const handledFriendParam = useRef<string | null>(null)
  useEffect(() => {
    const friendId = searchParams.get('u')
    if (!friendId || handledFriendParam.current === friendId) return
    handledFriendParam.current = friendId
    void openWithFriend(friendId)
  }, [searchParams, openWithFriend])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex shrink-0 items-center gap-3">
        <a
          href="/profile"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Назад в профиль"
        >
          <ArrowLeft className="size-4" />
        </a>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <MessageSquare className="size-5 text-muted-foreground" />
          Сообщения
          {totalUnread > 0 && (
            <span
              className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
              aria-label={`${totalUnread} непрочитанных сообщений`}
            >
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </h1>
        {unavailable ? (
          <span className="ml-auto text-xs text-destructive">Чат недоступен</span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
              aria-hidden="true"
            />
            {connected ? 'На связи' : 'Подключение…'}
          </span>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[300px_1fr]">
        {/* Список диалогов: на мобильном скрывается, когда открыт диалог */}
        <div className={active ? 'hidden min-h-0 md:flex' : 'flex min-h-0'}>
          <ConversationList
            conversations={conversations}
            friends={friends}
            activeId={activeId}
            isLoading={isLoading}
            selfId={selfId}
            onSelect={openConversation}
            onStartWithFriend={openWithFriend}
          />
        </div>

        <div className={active ? 'flex min-h-0' : 'hidden min-h-0 md:flex'}>
          <ConversationView
            conversation={active}
            selfId={selfId}
            socket={socket}
            connected={connected}
            onBack={() => setActiveId(null)}
            onReadFallback={markReadFallback}
          />
        </div>
      </div>
    </div>
  )
}
