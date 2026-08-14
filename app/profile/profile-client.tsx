'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useDmPresence } from '@/hooks/dm/use-dm-presence'
import { useConversations } from '@/hooks/dm/use-conversations'
import { useDmStore } from '@/stores/dm-store'
import { cn } from '@/lib/utils'
import { ConversationList } from '@/app/chat/conversation-list'
import { ConversationView } from '@/app/chat/conversation-view'
import { ProfileTopbar } from './profile-topbar'
import { AccountDialog } from './account-dialog'
import { FriendsList } from './friends-list'
import {
  fetcher,
  type User,
  type FriendsResponse,
  type PendingRequest,
  type SentRequest,
} from './types'

type Pane = 'chats' | 'friends'

/**
 * Личный кабинет в раскладке мессенджера: слева список чатов и друзей, справа
 * открытая переписка, сверху действия с заявками.
 *
 * Раньше кабинет и переписка были двумя страницами: из профиля кнопка «Написать»
 * уводила на /chat. Теперь это один экран, поэтому весь стейт диалогов
 * (активный диалог, счётчики, presence) живёт здесь — на /chat он дублировался
 * бы и терялся при переходе.
 */
export function ProfileClient({ user }: { user: User }) {
  const [pane, setPane] = useState<Pane>('chats')
  const [activeId, setActiveId] = useState<string | null>(null)

  const { socket, connected, unavailable } = useDmSocket()

  // Единственный на приложение подписчик на эфемерные события: presence,
  // «печатает…», прочтение собеседника. Без него точки «в сети», индикатор
  // набора и вторые галочки не работают.
  useDmPresence(socket, user.id)

  // Список диалогов, счётчики и все мутации живут в useConversations: тот же
  // SWR-ключ читают бейджи вне этой страницы, поэтому число непрочитанных
  // всегда совпадает.
  const { conversations, isLoading, zeroUnreadLocally, startWithFriend, markReadFallback } =
    useConversations(user.id, activeId)

  const { data: friendsData, isLoading: friendsLoading } = useSWR<FriendsResponse>(
    '/api/friends',
    fetcher,
  )
  const { data: pendingData, isLoading: pendingLoading } = useSWR<{
    pending: PendingRequest[]
  }>('/api/friends/pending', fetcher)
  const { data: sentData, isLoading: sentLoading } = useSWR<{ sent: SentRequest[] }>(
    '/api/friends/sent',
    fetcher,
  )

  // Статусы из HTTP-ответа кладём в тот же стор, что и события сокета: списки
  // читают только его, поэтому им не нужно знать, откуда пришли данные.
  //
  // mergePresence не перетирает снапшот сокета (см. stores/dm-store): ответ
  // /api/friends мог быть собран раньше и «оживил» бы уже ушедшего человека.
  // Времена последнего присутствия берутся всегда — они из Postgres.
  const mergePresence = useDmStore((s) => s.mergePresence)
  const presence = friendsData?.presence
  useEffect(() => {
    if (!presence) return
    mergePresence(presence.statuses ?? {}, presence.lastSeenAt ?? {})
  }, [presence, mergePresence])

  const friends = friendsData?.friends ?? []
  const pending = pendingData?.pending ?? []
  const sent = sentData?.sent ?? []

  const active = conversations.find((c) => c.id === activeId) ?? null

  const displayName =
    ((user as unknown as Record<string, unknown>).username as string | undefined) ?? user.name

  // Сообщаем глобальному уведомителю, какой диалог открыт: он монтируется вне
  // этой страницы и о локальном activeId ничего не знает, а без этого играл бы
  // звук по сообщениям из диалога, который пользователь и так видит.
  const setActiveConversationId = useDmStore((s) => s.setActiveConversationId)
  useEffect(() => {
    setActiveConversationId(activeId)
    return () => setActiveConversationId(null)
  }, [activeId, setActiveConversationId])

  const openConversation = useCallback(
    (conversationId: string) => {
      setActiveId(conversationId)
      zeroUnreadLocally(conversationId)
    },
    [zeroUnreadLocally],
  )

  // Создать диалог и сразу открыть его. Обёртка над startWithFriend из хука:
  // сам хук об активном диалоге ничего не знает. Переключаем панель на «Чаты» —
  // иначе переписка открылась бы справа, а слева остался бы список друзей.
  const openWithFriend = useCallback(
    async (friendId: string) => {
      const conversationId = await startWithFriend(friendId)
      if (conversationId) {
        setPane('chats')
        openConversation(conversationId)
      }
    },
    [startWithFriend, openConversation],
  )

  // Глубокие ссылки: ?c=<conversationId> и ?u=<friendId>. Их присылают
  // уведомления и кнопка «Сообщения» в шапке.
  const searchParams = useSearchParams()
  useEffect(() => {
    const fromUrl = searchParams.get('c')
    if (fromUrl) setActiveId(fromUrl)
  }, [searchParams])

  // В отличие от ?c=, диалога в БД может ещё не быть, поэтому идём через
  // startWithFriend: он создаёт его при необходимости и только потом открывает.
  const handledFriendParam = useRef<string | null>(null)
  useEffect(() => {
    const friendId = searchParams.get('u')
    if (!friendId || handledFriendParam.current === friendId) return
    handledFriendParam.current = friendId
    void openWithFriend(friendId)
  }, [searchParams, openWithFriend])

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)

  // Иконок в табах нет намеренно: подпись + иконка + бейдж на два коротких
  // слова — три способа сказать одно и то же. countLabel озвучивает цифру
  // скринридеру: «7» без него не отличить от непрочитанных.
  const panes: { id: Pane; label: string; count: number; countLabel: string }[] = [
    { id: 'chats', label: 'Чаты', count: totalUnread, countLabel: 'непрочитанных' },
    { id: 'friends', label: 'Друзья', count: friends.length, countLabel: 'друзей' },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 md:gap-4">
      <ProfileTopbar
        pending={pending}
        pendingLoading={pendingLoading}
        sent={sent}
        sentLoading={sentLoading}
        connected={connected}
        unavailable={unavailable}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[320px_1fr] md:gap-4">
        {/* Левая панель: аккаунт, переключатель и список. На мобильном скрыта,
            когда открыт диалог — иначе две колонки не поместились бы. */}
        <aside
          className={cn(
            'panel-surface min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 backdrop-blur-xl',
            active ? 'hidden md:flex' : 'flex',
          )}
        >
          {/* Своей линии снизу у блока аккаунта больше нет: её роль взял на себя
              рельс табов, а две горизонтальные линии в 60px друг от друга
              выглядели бы как случайная полоса. */}
          <div className="shrink-0 p-2 pb-1">
            <AccountDialog displayName={displayName} email={user.email} />
          </div>

          {/* Подчёркивание вместо «плашки в плашке»: панель уже лежит на
              градиентной сцене, и третий слой фона (серая подложка + белая
              карточка активного таба) читался бы как рамка внутри рамки. */}
          <div className="shrink-0 border-b border-border/60 px-3">
            <div role="tablist" aria-label="Разделы кабинета" className="-mb-px flex gap-5">
              {panes.map(({ id, label, count, countLabel }) => {
                const selected = pane === id
                return (
                  <button
                    key={id}
                    id={`pane-tab-${id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`pane-panel-${id}`}
                    onClick={() => setPane(id)}
                    className={cn(
                      // Начертание одно на оба состояния: сменой на semibold
                      // активный таб менял бы ширину и сдвигал соседний.
                      'flex items-baseline gap-1.5 border-b-2 pb-2 pt-2.5 text-[13px] font-medium tracking-tight transition-colors',
                      selected
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span>{label}</span>
                    {/* Слот под счётчик всегда одной ширины и с табличными
                        цифрами. Раньше это была пилюля по размеру содержимого:
                        «7» и «15» давали разную ширину, поэтому подпись съезжала
                        по горизонтали, а сам таб тянул за собой соседний.
                        Базовая линия — общая с подписью, так что цифра стоит
                        ровно по оптике, а не по центру рамки. */}
                    <span
                      className={cn(
                        'min-w-[2ch] text-left text-[11px] tabular-nums',
                        selected ? 'text-foreground/55' : 'text-muted-foreground/70',
                      )}
                    >
                      {count > 0 ? (count > 99 ? '99+' : count) : ''}
                      {count > 0 && <span className="sr-only"> {countLabel}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div
            id={`pane-panel-${pane}`}
            role="tabpanel"
            aria-labelledby={`pane-tab-${pane}`}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {pane === 'chats' ? (
              <ConversationList
                conversations={conversations}
                friends={friends}
                activeId={activeId}
                isLoading={isLoading}
                selfId={user.id}
                onSelect={openConversation}
                onStartWithFriend={openWithFriend}
              />
            ) : (
              <FriendsList
                friends={friends}
                isLoading={friendsLoading}
                onMessage={openWithFriend}
              />
            )}
          </div>
        </aside>

        <div className={cn('min-h-0', active ? 'flex' : 'hidden md:flex')}>
          <ConversationView
            conversation={active}
            selfId={user.id}
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
