'use client'

import { useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus, Search, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDmStore } from '@/stores/dm-store'
import type { Friend } from '@/app/profile/types'
import { conversationTitle, normalizeAttachment, type DmConversation } from './types'

interface ConversationListProps {
  conversations: DmConversation[]
  friends: Friend[]
  activeId: string | null
  isLoading: boolean
  selfId: string
  onSelect: (conversationId: string) => void
  onStartWithFriend: (friendId: string) => void
}

function formatListTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

/**
 * Превью последнего сообщения. Сообщение может быть без текста (только файл) —
 * тогда показываем имя вложения, иначе строка выглядела бы как пустой диалог.
 */
function formatPreview(c: DmConversation, selfId: string): string {
  const attachment = normalizeAttachment(c.lastMessageAttachment)
  const body = c.lastMessageText || (attachment ? `Файл: ${attachment.name}` : '')
  if (!body) return 'Нет сообщений'
  return `${c.lastMessageSenderId === selfId ? 'Вы: ' : ''}${body}`
}

export function ConversationList({
  conversations,
  friends,
  activeId,
  isLoading,
  selfId,
  onSelect,
  onStartWithFriend,
}: ConversationListProps) {
  const onlineIds = useDmStore((s) => s.onlineIds)
  const [query, setQuery] = useState('')

  const search = query.trim().toLowerCase()

  // Фильтрация по имени собеседника. Отдельного поиска по сообщениям нет: в
  // сторе лежит только последняя реплика каждого диалога, поэтому «поиск» по
  // ней находил бы случайные совпадения и молчал бы по остальной истории.
  const visibleConversations = useMemo(
    () =>
      search
        ? conversations.filter((c) => conversationTitle(c).toLowerCase().includes(search))
        : conversations,
    [conversations, search],
  )

  // Друзья, с которыми переписки ещё нет — быстрый старт нового диалога.
  const withoutConversation = useMemo(() => {
    const rest = friends.filter((f) => !conversations.some((c) => c.friendId === f.friendId))
    return search
      ? rest.filter((f) => (f.friendUsername ?? f.friendName).toLowerCase().includes(search))
      : rest
  }, [friends, conversations, search])

  const nothingFound =
    visibleConversations.length === 0 && withoutConversation.length === 0

  return (
    // Ни рамки, ни своего заголовка: список вложен в левую панель кабинета,
    // которая даёт и то, и другое, а переключатель «Чаты / Друзья» над ним уже
    // подписывает раздел.
    <div className="flex min-h-0 w-full flex-col overflow-hidden">
      <div className="shrink-0 p-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск"
            aria-label="Поиск по диалогам"
            className="h-9 w-full rounded-full border border-transparent bg-foreground/5 pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              aria-label="Очистить поиск"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <ul className="flex flex-col px-2 pb-2">
              {visibleConversations.map((c) => {
                const title = conversationTitle(c)
                const isActive = c.id === activeId
                const preview = formatPreview(c, selfId)
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors',
                        // Активный диалог красим акцентом, как в Telegram: в
                        // раскладке «список слева, переписка справа» иначе не
                        // видно, какой из них открыт справа.
                        isActive
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-foreground/5',
                      )}
                    >
                      <span
                        className={cn(
                          'relative flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                          isActive
                            ? 'bg-primary-foreground/20 text-primary-foreground'
                            : 'bg-gradient-to-br from-primary/85 to-primary/60 text-primary-foreground',
                        )}
                      >
                        {title.charAt(0).toUpperCase()}
                        {onlineIds.has(c.friendId) && (
                          <span
                            className={cn(
                              'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 bg-emerald-500',
                              isActive ? 'border-primary' : 'border-card',
                            )}
                            aria-label="в сети"
                          />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium">{title}</span>
                          <span
                            className={cn(
                              'ml-auto shrink-0 text-[10px]',
                              isActive ? 'text-primary-foreground/70' : 'text-muted-foreground',
                            )}
                          >
                            {formatListTime(c.lastMessageAt)}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'truncate text-xs',
                            isActive ? 'text-primary-foreground/80' : 'text-muted-foreground',
                          )}
                        >
                          {preview}
                        </span>
                      </span>
                      {c.unreadCount > 0 && !isActive && (
                        <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>

            {withoutConversation.length > 0 && (
              <div className="border-t border-border/60 p-2">
                <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Начать диалог
                </p>
                <ul className="flex flex-col">
                  {withoutConversation.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => onStartWithFriend(f.friendId)}
                        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/5"
                      >
                        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                          {(f.friendUsername ?? f.friendName).charAt(0).toUpperCase()}
                          {onlineIds.has(f.friendId) && (
                            <span
                              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500"
                              aria-label="в сети"
                            />
                          )}
                        </span>
                        <span className="truncate text-sm text-foreground">
                          {f.friendUsername ?? f.friendName}
                        </span>
                        <MessageSquarePlus className="ml-auto size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Пусто по двум разным причинам: либо друзей ещё нет, либо ничего
                не нашлось по запросу. Один текст на оба случая сбивал бы с
                толку — при активном поиске он советовал бы добавить друзей. */}
            {nothingFound && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                {search ? (
                  <>
                    <Search className="size-8 text-muted-foreground/30" aria-hidden="true" />
                    <p className="text-pretty text-sm text-muted-foreground">
                      Ничего не найдено по запросу «{search}»
                    </p>
                  </>
                ) : (
                  <>
                    <Users className="size-8 text-muted-foreground/30" aria-hidden="true" />
                    <p className="text-pretty text-sm text-muted-foreground">
                      Добавьте друзей кнопкой сверху, чтобы начать переписку
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
