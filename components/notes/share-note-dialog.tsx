'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { fetcher, type FriendsResponse } from '@/app/profile/types'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { shareNoteWithFriends } from '@/lib/chat/share-note'

interface ShareNoteDialogProps {
  noteId: string | null
  noteTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShareNoteDialog({ noteId, noteTitle, open, onOpenChange }: ShareNoteDialogProps) {
  const { data, isLoading } = useSWR<FriendsResponse>(open ? '/api/friends' : null, fetcher)
  const { socket } = useDmSocket()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const friends = data?.friends ?? []

  const toggle = (id: string) => {
    setResult(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const send = async () => {
    if (!noteId || selected.size === 0) return
    setSending(true)
    setError(null)
    try {
      const shared = await shareNoteWithFriends(
        { id: noteId, title: noteTitle },
        [...selected],
        socket,
      )
      setResult(`Отправлено: ${shared}`)
      setSelected(new Set())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setResult(null)
      setError(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Отправить конспект</DialogTitle>
          <DialogDescription>
            Конспект придёт друзьям в личный чат и появится у них в разделе «Конспекты».
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50dvh] overflow-y-auto rounded-lg border border-border">
          {isLoading ? (
            <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">Загрузка друзей</span>
            </div>
          ) : friends.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Друзей пока нет. Добавьте ученика в друзья в кабинете.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {friends.map((f) => {
                const name = f.friendUsername || f.friendName
                const isOn = selected.has(f.friendId)
                return (
                  <li key={f.friendId}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isOn}
                      onClick={() => toggle(f.friendId)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase">
                        {name.slice(0, 1)}
                      </span>
                      <span className="flex-1 truncate">{name}</span>
                      <span
                        className={cn(
                          'flex size-5 items-center justify-center rounded-md border border-border',
                          isOn && 'border-primary bg-primary text-primary-foreground',
                        )}
                        aria-hidden="true"
                      >
                        {isOn && <Check className="size-3.5" />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {result && <p className="text-sm text-muted-foreground" role="status">{result}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Закрыть
          </Button>
          <Button onClick={send} disabled={sending || selected.size === 0}>
            {sending && <Loader2 className="animate-spin" />}
            Отправить{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
