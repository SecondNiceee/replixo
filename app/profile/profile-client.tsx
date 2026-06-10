'use client'

import { useState, useRef } from 'react'
import useSWR, { mutate } from 'swr'
import { UserCircle, UserPlus, Users, Check, X, UserMinus, Loader2, Pencil, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface User {
  id: string
  name: string
  email: string
}

interface Friend {
  id: string
  friendId: string
  friendName: string
  friendUsername: string | null
}

interface PendingRequest {
  id: string
  requesterId: string
  requesterName: string
  requesterUsername: string | null
}

interface SentRequest {
  id: string
  addresseeId: string
  addresseeName: string
  addresseeUsername: string | null
  createdAt: string
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Tab = 'friends' | 'sent'

export function ProfileClient({ user }: { user: User }) {
  const [activeTab, setActiveTab] = useState<Tab>('friends')

  const { data: friendsData, isLoading: friendsLoading } = useSWR<{ friends: Friend[] }>(
    '/api/friends',
    fetcher,
  )
  const { data: pendingData, isLoading: pendingLoading } = useSWR<{
    pending: PendingRequest[]
  }>('/api/friends/pending', fetcher)
  const { data: sentData, isLoading: sentLoading } = useSWR<{ sent: SentRequest[] }>(
    '/api/friends/sent',
    fetcher,
  )

  // --- username edit ---
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameLoading, setNameLoading] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const startEditName = () => {
    setNameValue(displayName)
    setNameError(null)
    setEditingName(true)
    setTimeout(() => nameInputRef.current?.select(), 0)
  }

  const cancelEditName = () => {
    setEditingName(false)
    setNameError(null)
  }

  const submitEditName = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed || trimmed === displayName) {
      setEditingName(false)
      return
    }
    setNameLoading(true)
    setNameError(null)
    const res = await fetch('/api/user/username', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
    })
    const data = await res.json()
    setNameLoading(false)
    if (!res.ok) {
      setNameError(data.error ?? 'Ошибка')
      return
    }
    window.location.reload()
  }

  // --- add friend ---
  const [addUsername, setAddUsername] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  // --- cancel sent request ---
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set())

  const friends = friendsData?.friends ?? []
  const pending = pendingData?.pending ?? []
  const sent = sentData?.sent ?? []

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
    mutate('/api/friends/sent')
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

  const handleCancel = async (friendshipId: string) => {
    setCancellingId(friendshipId)
    const res = await fetch('/api/friends/cancel', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendshipId }),
    })
    setCancellingId(null)
    if (res.ok) {
      setCancelledIds((prev) => new Set(prev).add(friendshipId))
      mutate('/api/friends/sent')
    }
  }

  const displayName = (user as unknown as Record<string, unknown>).username as string | undefined
    ?? user.name

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'friends', label: 'Друзья', count: friends.length || undefined },
    { id: 'sent', label: 'Мои заявки', count: sent.length || undefined },
  ]

  return (
    <div className="flex flex-col gap-8">
      {/* Profile header */}
      <div className="flex items-start gap-4">
        <div className="mt-1 flex size-14 shrink-0 items-center justify-center rounded-full bg-secondary text-xl font-semibold text-foreground">
          {displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          {editingName ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  ref={nameInputRef}
                  value={nameValue}
                  onChange={(e) => {
                    setNameValue(e.target.value)
                    setNameError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitEditName()
                    if (e.key === 'Escape') cancelEditName()
                  }}
                  maxLength={20}
                  className="h-8 w-48 text-base font-semibold"
                  disabled={nameLoading}
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  onClick={submitEditName}
                  disabled={nameLoading}
                  aria-label="Сохранить имя"
                >
                  {nameLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Check className="size-4" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={cancelEditName}
                  disabled={nameLoading}
                  aria-label="Отменить"
                >
                  <X className="size-4" />
                </Button>
              </div>
              {nameError && (
                <p className="text-xs text-destructive" role="alert">
                  {nameError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Только латинские буквы, цифры, _ (2–20 символов)
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">{displayName}</h1>
              <button
                onClick={startEditName}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Изменить username"
              >
                <Pencil className="size-4" />
              </button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[300px_1fr]">
        {/* Left — tabs + list */}
        <aside className="flex flex-col gap-4">
          {/* Tab switcher */}
          <div className="flex rounded-lg border border-border bg-secondary/30 p-1 gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                      activeTab === tab.id
                        ? 'bg-secondary text-foreground'
                        : 'bg-secondary/50 text-muted-foreground'
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Friends tab */}
          {activeTab === 'friends' && (
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
          )}

          {/* Sent tab */}
          {activeTab === 'sent' && (
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

              {sentLoading ? (
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
                            onClick={() => handleCancel(s.id)}
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
          )}
        </aside>

        {/* Right — add friend + pending incoming */}
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
