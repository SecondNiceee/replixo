'use client'

import { mutate } from 'swr'
import { Users, UserMinus, Loader2 } from 'lucide-react'
import type { Friend } from './types'

interface FriendsListProps {
  friends: Friend[]
  isLoading: boolean
}

export function FriendsList({ friends, isLoading }: FriendsListProps) {
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
  )
}
