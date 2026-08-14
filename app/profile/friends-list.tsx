'use client'

import { useState } from 'react'
import { Users, UserMinus, Loader2, MessageSquare } from 'lucide-react'
import { usePresenceLastSeen, usePresenceStatus } from '@/stores/dm-store'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useNow } from '@/hooks/use-now'
import { PresenceDot } from '@/components/chat/presence-dot'
import { presenceLabel } from '@/app/chat/types'
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
  /**
   * Открыть переписку с другом. Раньше кнопка «Написать» уводила на отдельную
   * страницу /chat; теперь список чатов и переписка живут на одном экране, и
   * навигация здесь только сбрасывала бы состояние открытого диалога.
   */
  onMessage: (friendId: string) => void
}

export function FriendsList({ friends, isLoading, onMessage }: FriendsListProps) {
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
    // Контейнер без рамки и фона: их даёт левая панель кабинета, а вложенная
    // карточка внутри панели читалась бы как вторая рамка.
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
            <FriendRow
              key={f.id}
              friend={f}
              removing={removingId === f.id}
              onMessage={onMessage}
              onRemove={handleRemove}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface FriendRowProps {
  friend: Friend
  removing: boolean
  onMessage: (friendId: string) => void
  onRemove: (friendshipId: string, friendId: string) => void
}

/**
 * Строка списка — отдельный компонент, а не разметка внутри map: статус и время
 * читаются хуками, а хук нельзя вызвать в цикле. Плюс подписка получается точной
 * — перерисуется только та строка, чей друг сменил статус, а не весь список.
 */
function FriendRow({ friend, removing, onMessage, onRemove }: FriendRowProps) {
  const name = friend.friendUsername ?? friend.friendName
  const status = usePresenceStatus(friend.friendId)
  const lastSeenAt = usePresenceLastSeen(friend.friendId)
  // Тикающее «сейчас» нужно только оффлайн-строкам: у остальных подпись
  // постоянная («в сети», «отошёл(ла)»), и обновлять её незачем.
  const now = useNow(status === 'offline')
  const label = presenceLabel(status, lastSeenAt, now)

  return (
    <li className="group flex items-center justify-between rounded-lg px-2 py-2 hover:bg-secondary/50">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
          {name.charAt(0).toUpperCase()}
          {/* label пустой: статус уже написан текстом ниже, и озвучивать его
              скринридеру дважды не нужно. */}
          <PresenceDot status={status} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{name}</span>
          <span
            className={cn(
              'truncate text-[11px]',
              status === 'online'
                ? 'text-emerald-400'
                : status === 'idle'
                  ? 'text-amber-400'
                  : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => onMessage(friend.friendId)}
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Написать ${name}`}
        >
          <MessageSquare className="size-4" />
        </button>
        <button
          onClick={() => onRemove(friend.id, friend.friendId)}
          disabled={removing}
          // Пока запрос летит, кнопку показываем и без ховера: иначе
          // спиннер прячется, стоит увести курсор со строки.
          className={cn(
            'text-muted-foreground transition-colors hover:text-destructive disabled:opacity-60',
            removing ? 'flex' : 'hidden group-hover:flex',
          )}
          aria-label="Удалить из друзей"
        >
          {removing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UserMinus className="size-4" />
          )}
        </button>
      </div>
    </li>
  )
}
