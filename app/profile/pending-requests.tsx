'use client'

import { useState } from 'react'
import { UserCircle, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import {
  friendsAction,
  notifyFriendsChanged,
  reportFriendsActionError,
} from '@/hooks/dm/use-friends-realtime'
import type { PendingRequest } from './types'

interface PendingRequestsProps {
  pending: PendingRequest[]
  isLoading: boolean
}

export function PendingRequests({ pending, isLoading }: PendingRequestsProps) {
  const { socket } = useDmSocket()
  const [busyId, setBusyId] = useState<string | null>(null)

  const handleAccept = async (friendshipId: string, requesterId: string) => {
    setBusyId(friendshipId)
    const result = await friendsAction(socket, '/api/friends/accept', 'POST', {
      friendshipId,
    })
    setBusyId(null)

    if (!result.ok) {
      // Без этой ветки кнопка просто перестала бы крутиться, ничего не изменив:
      // самый частый случай здесь — заявку уже отозвали, пока страница открыта.
      reportFriendsActionError(result)
      return
    }

    // Свои списки обновляются всегда; фолбэк-emit — только если серверный
    // хук не подтвердил рассылку (notified: false).
    notifyFriendsChanged(socket, requesterId, 'accepted', result.data?.notified === true)
  }

  const handleDecline = async (friendshipId: string, requesterId: string) => {
    setBusyId(friendshipId)
    const result = await friendsAction(socket, '/api/friends/decline', 'POST', {
      friendshipId,
    })
    setBusyId(null)

    if (!result.ok) {
      reportFriendsActionError(result)
      return
    }

    notifyFriendsChanged(socket, requesterId, 'declined', result.data?.notified === true)
  }

  // Пустой список раньше возвращал null. Внутри вкладки «Входящие» это давало
  // просто пустое место под переключателем — непонятно, то ли не загрузилось,
  // то ли заявок нет. Поэтому теперь показываем явную заглушку.
  return (
    // Без своей карточки и заголовка: раздел открыт во вкладке диалога
    // «Заявки», рамку и подпись даёт он.
    <div className="flex flex-col gap-2">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : pending.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <UserCircle className="size-8 text-muted-foreground/30" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Новых заявок нет</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/75 text-sm font-semibold text-primary-foreground">
                  {(p.requesterUsername ?? p.requesterName).charAt(0).toUpperCase()}
                </span>
                <span className="truncate text-sm font-medium text-foreground">
                  {p.requesterUsername ?? p.requesterName}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => handleAccept(p.id, p.requesterId)}
                  disabled={busyId === p.id}
                  className="h-8 gap-1 px-2.5 text-xs"
                >
                  {busyId === p.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Принять
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDecline(p.id, p.requesterId)}
                  disabled={busyId === p.id}
                  className="h-8 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                >
                  <X className="size-3.5" />
                  Отклонить
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
