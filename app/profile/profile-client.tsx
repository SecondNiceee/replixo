'use client'

import { useState } from 'react'
import useSWR, { mutate } from 'swr'
import { UserCircle, UserPlus, Users, Check, X, UserMinus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface User {
  id: string
  name: string
  email: string
}

interface Friend {
  id: string // friendship id
  friendId: string
  friendName: string
  friendUsername: string | null
}

interface PendingRequest {
  id: string // friendship id
  requesterId: string
  requesterName: string
  requesterUsername: string | null
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function ProfileClient({ user }: { user: User }) {
  const { data: friendsData, isLoading: friendsLoading } = useSWR<{ friends: Friend[] }>(
    '/api/friends',
    fetcher,
  )
  const { data: pendingData, isLoading: pendingLoading } = useSWR<{
    pending: PendingRequest[]
  }>('/api/friends/pending', fetcher)

  const [addUsername, setAddUsername] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  const friends = friendsData?.friends ?? []
  const pending = pendingData?.pending ?? []

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = addUsername.trim()
    if (!trimmed) return

    setAddLoading(true)
    setAddError(null)
    setAddSuccess(null)

    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
    })

    const data = await res.json()
    setAddLoading(false)

    if (!res.ok) {
      setAddError(data.error ?? 'Ошибка')
      return
    }

    setAddUsername('')
    setAddSuccess(`Заявка отправлена пользователю ${trimmed}`)
  }

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

  const handleRemove = async (friendshipId: string) => {
    const res = await fetch('/api/friends/remove', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    if (res.ok) {
      mutate('/api/friends')
    }
  }

  const displayName = (user as unknown as Record<string, unknown>).username as string | undefined
    ?? user.name

  return (
    <div className="flex flex-col gap-8">
      {/* Profile header */}
      <div className="flex items-center gap-4">
        <div className="flex size-16 items-center justify-center rounded-full bg-secondary text-2xl font-semibold text-foreground">
          {displayName.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{displayName}</h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[300px_1fr]">
        {/* Left — friends list */}
        <aside className="flex flex-col gap-4">
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

            {friendsLoading ? (
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
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-sm font-medium text-foreground">
                        {(f.friendUsername ?? f.friendName).charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm text-foreground">
                        {f.friendUsername ?? f.friendName}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemove(f.id)}
                      className="hidden text-muted-foreground transition-colors hover:text-destructive group-hover:flex"
                      aria-label="Удалить из друзей"
                    >
                      <UserMinus className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Right — add friend + pending */}
        <section className="flex flex-col gap-4">
          {/* Add friend */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <UserPlus className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-foreground">Добавить друга</h2>
            </div>
            <form onSubmit={handleAddFriend} className="flex gap-2">
              <Input
                value={addUsername}
                onChange={(e) => {
                  setAddUsername(e.target.value)
                  setAddError(null)
                  setAddSuccess(null)
                }}
                placeholder="Введите username"
                maxLength={20}
                className="flex-1"
              />
              <Button type="submit" size="sm" disabled={addLoading || !addUsername.trim()}>
                {addLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
                <span className="hidden sm:inline">Отправить</span>
              </Button>
            </form>
            {addError && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                {addError}
              </p>
            )}
            {addSuccess && (
              <p className="mt-2 text-sm text-green-500" role="status">
                {addSuccess}
              </p>
            )}
          </div>

          {/* Pending incoming requests */}
          {(pendingLoading || pending.length > 0) && (
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

              {pendingLoading ? (
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
          )}
        </section>
      </div>
    </div>
  )
}
