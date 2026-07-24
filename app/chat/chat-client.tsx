'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useDmPresence } from '@/hooks/dm/use-dm-presence'
import { playIncomingMessage } from '@/lib/sounds'
import type { Friend } from '@/app/profile/types'
import { ConversationList } from './conversation-list'
import { ConversationView } from './conversation-view'
import { chatFetcher, type DmConversation } from './types'

const CONVERSATIONS_KEY = '/api/chat/conversations'

export function ChatClient({ selfId }: { selfId: string }) {
  const { socket, connected, unavailable } = useDmSocket()
  const searchParams = useSearchParams()

  // Единственный на приложение подписчик на эфемерные события: presence,
  // «печатает…», прочтение собеседника. Без него точки «в сети», индикатор
  // набора и вторые галочки не работают.
  useDmPresence(socket, selfId)

  const { data, mutate, isLoading } = useSWR<{ conversations: DmConversation[] }>(
    CONVERSATIONS_KEY,
    chatFetcher,
  )
  const { data: friendsData } = useSWR<{ friends: Friend[] }>('/api/friends', chatFetcher)

  const conversations = data?.conversations ?? []
  const friends = friendsData?.friends ?? []

  const [activeId, setActiveId] = useState<string | null>(null)
  const active = conversations.find((c) => c.id === activeId) ?? null

  // Локально погасить счётчик, ничего не записывая на сервер. Нужно, чтобы
  // бейдж и заголовок вкладки реагировали мгновенно: авторитетную запись
  // делает useDmRead через сокет (и только когда это честно — вкладка видима
  // и лента доскроллена вниз), а это занимает как минимум дебаунс.
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

  // Перечитать список, но сохранить нулевой счётчик активного диалога: в БД он
  // ещё не обнулён (сокетная отметка в пути), и без этого бейдж мигал бы.
  const refreshKeepingRead = useCallback(
    (conversationId: string) => {
      void mutate(async () => {
        const fresh = (await chatFetcher(CONVERSATIONS_KEY)) as {
          conversations: DmConversation[]
        }
        return {
          conversations: fresh.conversations.map((c) =>
            c.id === conversationId ? { ...c, unreadCount: 0 } : c,
          ),
        }
      }, { revalidate: false })
    },
    [mutate],
  )

  // Аварийная отметка прочтения по HTTP — только когда сокета нет. Этот роут
  // не рассылает dm:read, поэтому вторые галочки у собеседника появятся лишь
  // после его перезагрузки. Основной путь — сокет (см. useDmRead).
  const markReadFallback = useCallback(
    async (conversationId: string) => {
      await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/read`, {
        method: 'POST',
      }).catch(() => undefined)
      void mutate()
    },
    [mutate],
  )

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

  // Любое новое сообщение меняет порядок диалогов и счётчики — перечитываем
  // список. Отметку «прочитано» здесь НЕ ставим: этим занимается useDmRead
  // через сокет, только он даёт собеседнику вторые галочки и только он знает,
  // доскроллен ли пользователь до низа ленты.
  useEffect(() => {
    if (!socket) return

    const onMessage = (payload: unknown) => {
      const { conversationId, message } = (payload ?? {}) as {
        conversationId?: string
        message?: { senderId?: string }
      }
      const visible = document.visibilityState === 'visible'
      const isForeign = message?.senderId !== undefined && message.senderId !== selfId

      // Звук — только на чужие сообщения и только когда пользователь их не
      // видит: в открытом активном диалоге он и так следит за лентой.
      if (isForeign && (!visible || conversationId !== activeId)) {
        playIncomingMessage()
      }

      if (conversationId && conversationId === activeId && visible) {
        // Диалог открыт и на виду — обновляем превью, но бейдж держим на нуле
        // до подтверждения сокетом.
        refreshKeepingRead(conversationId)
        return
      }
      void mutate()
    }

    // Прочтение с другого устройства обнуляет счётчик в БД — список должен
    // это увидеть (сценарий «два устройства одного пользователя»).
    const onRead = (payload: unknown) => {
      const { userId } = (payload ?? {}) as { userId?: string }
      if (userId === selfId) void mutate()
    }

    socket.on('dm:message', onMessage)
    socket.on('dm:read', onRead)
    return () => {
      socket.off('dm:message', onMessage)
      socket.off('dm:read', onRead)
    }
  }, [socket, mutate, activeId, refreshKeepingRead, selfId])

  // Стор эфемерного состояния очищается при разрыве соединения (useDmPresence
  // делает reset), поэтому живой peerReadAt теряется. После реконнекта
  // перечитываем список — в нём есть peerLastReadAt из БД, и галочки
  // восстанавливаются, а не откатываются к одной.
  useEffect(() => {
    if (connected) void mutate()
  }, [connected, mutate])

  // Непрочитанные в заголовке вкладки: «(3) Replixo».
  const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)
  const baseTitle = useRef('')
  useEffect(() => {
    if (!baseTitle.current) {
      baseTitle.current = document.title.replace(/^\(\d+\)\s*/, '')
    }
    const base = baseTitle.current
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base
    return () => {
      document.title = base
    }
  }, [totalUnread])

  // Начать (или открыть существующий) диалог с другом.
  const startWithFriend = useCallback(
    async (friendId: string) => {
      const res = await fetch(CONVERSATIONS_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendId }),
      })
      if (!res.ok) return
      const { conversationId } = (await res.json()) as { conversationId: string }
      await mutate()
      openConversation(conversationId)
    },
    [mutate, openConversation],
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
    void startWithFriend(friendId)
  }, [searchParams, startWithFriend])

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
            onStartWithFriend={startWithFriend}
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
