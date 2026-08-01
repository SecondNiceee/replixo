'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Users, UserMinus, Loader2, MessageSquare } from 'lucide-react'
import { useDmStore } from '@/stores/dm-store'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import {
  friendsAction,
  notifyFriendsChanged,
  reportFriendsActionError,
} from '@/hooks/dm/use-friends-realtime'
import { cn } from '@/lib/utils'
import type { Friend } from './types'

interface FriendsListProps {
  friends: Friend[]
  isLoading: boolean
}

export function FriendsList({ friends, isLoading }: FriendsListProps) {
  const router = useRouter()
  // Точки «в сети» живут ровно столько, сколько открыт сокет presence
  // (его держит ProfileClient). Без соединения набор пуст — и точек нет.
  const onlineIds = useDmStore((s) => s.onlineIds)
  const { socket } = useDmSocket()
  const [removingId, setRemovingId] = useState<string | null>(null)

  const handleRemove = async (friendshipId: string, friendId: string) => {
    // Состояния занятости здесь не было вовсе: до ответа сервера кнопка выглядела
    // нетронутой, и её успевали нажать несколько раз — каждый клик уходил в
    // отдельный запрос и жёг лимит.
    setRemovingId(friendshipId)
    const result = await friendsAction(socket, '/api/friends/remove', 'DELETE', {
      friendshipId,
    })
    setRemovingId(null)

    if (!result.ok) {
      reportFriendsActionError(result)
      return
    }

    // Второй участник тоже должен увидеть, что дружбы больше нет.
    notifyFriendsChanged(socket, friendId, 'removed', result.data?.notified === true)
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">
          Друзья
          {friends.length > 0 && (
            <span className="ml-1.5 text-muted-foreground">({friends.length})</span>
          )}
        </h2>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : friends.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Users className="size-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Список друзей пуст</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {friends.map((f) => (
            <li
              key={f.id}
              className="group flex items-center justify-between rounded-lg px-2 py-2 hover:bg-secondary/50"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                  {(f.friendUsername ?? f.friendName).charAt(0).toUpperCase()}
                  {onlineIds.has(f.friendId) && (
                    <span
                      className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500"
                      aria-label="в сети"
                      role="img"
                    />
                  )}
                </span>
                <span className="truncate text-sm text-foreground">
                  {f.friendUsername ?? f.friendName}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => router.push(`/chat?u=${encodeURIComponent(f.friendId)}`)}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Написать ${f.friendUsername ?? f.friendName}`}
                >
                  <MessageSquare className="size-4" />
                </button>
                <button
                  onClick={() => handleRemove(f.id, f.friendId)}
                  disabled={removingId === f.id}
                  // Пока запрос летит, кнопку показываем и без ховера: иначе
                  // спиннер прячется, стоит увести курсор со строки.
                  className={cn(
                    'text-muted-foreground transition-colors hover:text-destructive disabled:opacity-60',
                    removingId === f.id ? 'flex' : 'hidden group-hover:flex',
                  )}
                  aria-label="Удалить из друзей"
                >
                  {removingId === f.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserMinus className="size-4" />
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
