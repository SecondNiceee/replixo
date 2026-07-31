'use client'

import { useState } from 'react'
import { Send, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { notifyFriendsChanged } from '@/hooks/dm/use-friends-realtime'
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
    const res = await fetch('/api/friends/cancel', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    const data = await res.json().catch(() => null)
    setCancellingId(null)
    if (res.ok) {
      setCancelledIds((prev) => new Set(prev).add(friendshipId))
      // У адресата заявка должна пропасть из входящих сразу.
      notifyFriendsChanged(socket, addresseeId, 'cancelled', data?.notified === true)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <Send className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">
          Мои заявки
          {sent.length > 0 && (
            <span className="ml-1.5 text-muted-foreground">({sent.length})</span>
          )}
        </h2>
      </div>

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
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 transition-opacity ${
                  isCancelled ? 'border-border/40 opacity-40' : 'border-border'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                    {(s.addresseeUsername ?? s.addresseeName).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm text-foreground">
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
