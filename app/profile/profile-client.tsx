'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { useDmPresence } from '@/hooks/dm/use-dm-presence'
import { ProfileHeader } from './profile-header'
import { FriendsList } from './friends-list'
import { SentRequests } from './sent-requests'
import { AddFriendForm } from './add-friend-form'
import { PendingRequests } from './pending-requests'
import { fetcher, type User, type Friend, type PendingRequest, type SentRequest } from './types'

type Tab = 'friends' | 'sent'

export function ProfileClient({ user }: { user: User }) {
  const [activeTab, setActiveTab] = useState<Tab>('friends')

  // Presence нужен только для точек «в сети» в списке друзей. Сокет живёт,
  // пока открыта страница; если чат недоступен, точек просто не будет.
  const { socket } = useDmSocket()
  useDmPresence(socket, user.id)

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

  const friends = friendsData?.friends ?? []
  const pending = pendingData?.pending ?? []
  const sent = sentData?.sent ?? []

  const displayName = (user as unknown as Record<string, unknown>).username as string | undefined
    ?? user.name

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'friends', label: 'Друзья', count: friends.length || undefined },
    { id: 'sent', label: 'Мои заявки', count: sent.length || undefined },
  ]

  return (
    <div className="flex flex-col gap-8">
      <ProfileHeader displayName={displayName} email={user.email} />

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

          {activeTab === 'friends' && <FriendsList friends={friends} isLoading={friendsLoading} />}
          {activeTab === 'sent' && <SentRequests sent={sent} isLoading={sentLoading} />}
        </aside>

        {/* Right — add friend + pending incoming */}
        <section className="flex flex-col gap-4">
          <AddFriendForm />
          <PendingRequests pending={pending} isLoading={pendingLoading} />
        </section>
      </div>
    </div>
  )
}
