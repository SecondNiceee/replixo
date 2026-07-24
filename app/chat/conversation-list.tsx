'use client'

import { Loader2, MessageSquarePlus, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Friend } from '@/app/profile/types'
import { conversationTitle, type DmConversation } from './types'

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

export function ConversationList({
  conversations,
  friends,
  activeId,
  isLoading,
  selfId,
  onSelect,
  onStartWithFriend,
}: ConversationListProps) {
  // Друзья, с которыми переписки ещё нет — быстрый старт нового диалога.
  const withoutConversation = friends.filter(
    (f) => !conversations.some((c) => c.friendId === f.friendId),
  )

  return (
    <aside className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Диалоги</h2>
        {conversations.length > 0 && (
          <span className="text-xs text-muted-foreground">({conversations.length})</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <ul className="flex flex-col p-2">
              {conversations.map((c) => {
                const title = conversationTitle(c)
                const isActive = c.id === activeId
                const preview = c.lastMessageText
                  ? `${c.lastMessageSenderId === selfId ? 'Вы: ' : ''}${c.lastMessageText}`
                  : 'Нет сообщений'
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      aria-current={isActive ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                        isActive ? 'bg-secondary' : 'hover:bg-secondary/50',
                      )}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                        {title.charAt(0).toUpperCase()}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {title}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                            {formatListTime(c.lastMessageAt)}
                          </span>
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{preview}</span>
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
              <div className="border-t border-border p-2">
                <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Начать диалог
                </p>
                <ul className="flex flex-col">
                  {withoutConversation.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => onStartWithFriend(f.friendId)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary/50"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary/60 text-sm font-medium text-muted-foreground">
                          {(f.friendUsername ?? f.friendName).charAt(0).toUpperCase()}
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

            {conversations.length === 0 && withoutConversation.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <Users className="size-8 text-muted-foreground/30" />
                <p className="text-pretty text-sm text-muted-foreground">
                  Добавьте друзей в профиле, чтобы начать переписку
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
