'use client'

import { useState } from 'react'
import { Send, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import {
  friendsAction,
  notifyFriendsChanged,
  reportFriendsActionError,
} from '@/hooks/dm/use-friends-realtime'
import { cn } from '@/lib/utils'
import type { SentRequest } from './types'

interface SentRequestsProps {
  sent: SentRequest[]
  isLoading: boolean
}

export function SentRequests({ sent, isLoading }: SentRequestsProps) {
  const { socket } = useDmSocket()
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set())

  const handleCancel = async (friendshipId: string, addresseeId: string) => {
    setCancellingId(friendshipId)
    const result = await friendsAction(socket, '/api/friends/cancel', 'DELETE', {
      friendshipId,
    })
    setCancellingId(null)

    if (!result.ok) {
      // Пометку «Отменена» не ставим: заявка жива, и кнопка должна остаться
      // доступной для повтора.
      reportFriendsActionError(result)
      return
    }

    setCancelledIds((prev) => new Set(prev).add(friendshipId))
    // У адресата заявка должна пропасть из входящих сразу.
    notifyFriendsChanged(socket, addresseeId, 'cancelled', result.data?.notified === true)
  }

  return (
    // Без своей карточки и заголовка: раздел открыт во вкладке диалога
    // «Заявки», рамку и подпись даёт он.
    <div className="flex flex-col gap-2">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : sent.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Send className="size-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Нет исходящих заявок</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sent.map((s) => {
            const isCancelled = cancelledIds.has(s.id)
            const isCancelling = cancellingId === s.id
            return (
              <li
                key={s.id}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 transition-opacity',
                  isCancelled
                    ? 'border-border/40 bg-secondary/10 opacity-40'
                    : 'border-border/60 bg-secondary/25',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                    {(s.addresseeUsername ?? s.addresseeName).charAt(0).toUpperCase()}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {s.addresseeUsername ?? s.addresseeName}
                    </span>
                    {isCancelled && (
                      <span className="text-[11px] text-muted-foreground">Отменена</span>
                    )}
                  </div>
                </div>
                {!isCancelled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCancel(s.id, s.addresseeId)}
                    disabled={isCancelling}
                    className="h-8 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                  >
                    {isCancelling ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                    Отменить
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
