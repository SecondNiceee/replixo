'use client'

import { useState } from 'react'
import { UserCircle, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { notifyFriendsChanged } from '@/hooks/dm/use-friends-realtime'
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
    const res = await fetch('/api/friends/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    const data = await res.json().catch(() => null)
    setBusyId(null)
    if (res.ok) {
      // Свои списки обновляются всегда; фолбэк-emit — только если серверный
      // хук не подтвердил рассылку (notified: false).
      notifyFriendsChanged(socket, requesterId, 'accepted', data?.notified === true)
    }
  }

  const handleDecline = async (friendshipId: string, requesterId: string) => {
    setBusyId(friendshipId)
    const res = await fetch('/api/friends/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    const data = await res.json().catch(() => null)
    setBusyId(null)
    if (res.ok) {
      notifyFriendsChanged(socket, requesterId, 'declined', data?.notified === true)
    }
  }

  if (!isLoading && pending.length === 0) return null

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <UserCircle className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">
          Входящие заявки
          {pending.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {pending.length}
            </span>
          )}
        </h2>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                  {(p.requesterUsername ?? p.requesterName).charAt(0).toUpperCase()}
                </div>
                <span className="text-sm text-foreground">
                  {p.requesterUsername ?? p.requesterName}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
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
