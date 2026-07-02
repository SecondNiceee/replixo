'use client'

import { mutate } from 'swr'
import { UserCircle, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PendingRequest } from './types'

interface PendingRequestsProps {
  pending: PendingRequest[]
  isLoading: boolean
}

export function PendingRequests({ pending, isLoading }: PendingRequestsProps) {
  const handleAccept = async (friendshipId: string) => {
    const res = await fetch('/api/friends/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    if (res.ok) {
      mutate('/api/friends')
      mutate('/api/friends/pending')
    }
  }

  const handleDecline = async (friendshipId: string) => {
    const res = await fetch('/api/friends/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    if (res.ok) {
      mutate('/api/friends/pending')
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
                  onClick={() => handleAccept(p.id)}
                  className="h-8 gap-1 px-2.5 text-xs"
                >
                  <Check className="size-3.5" />
                  Принять
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDecline(p.id)}
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
