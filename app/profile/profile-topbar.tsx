'use client'

import { useState } from 'react'
import { Inbox, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { AddFriendForm } from './add-friend-form'
import { PendingRequests } from './pending-requests'
import { SentRequests } from './sent-requests'
import type { PendingRequest, SentRequest } from './types'

interface ProfileTopbarProps {
  pending: PendingRequest[]
  pendingLoading: boolean
  sent: SentRequest[]
  sentLoading: boolean
  connected: boolean
  unavailable: boolean
}

type RequestsTab = 'incoming' | 'outgoing'

/**
 * Верхняя панель кабинета: «Добавить в друзья» и «Заявки».
 *
 * Оба раздела живут в диалогах, а не в колонке страницы. Это разовые действия
 * («добавил» / «принял»), а постоянного места на экране они лишали бы главное —
 * список чатов и саму переписку.
 */
export function ProfileTopbar({
  pending,
  pendingLoading,
  sent,
  sentLoading,
  connected,
  unavailable,
}: ProfileTopbarProps) {
  const [requestsTab, setRequestsTab] = useState<RequestsTab>('incoming')

  const tabs: { id: RequestsTab; label: string; count: number }[] = [
    { id: 'incoming', label: 'Входящие', count: pending.length },
    { id: 'outgoing', label: 'Исходящие', count: sent.length },
  ]

  return (
    <header className="topbar-surface flex shrink-0 items-center gap-2 rounded-2xl border border-border/60 px-3 py-2 backdrop-blur-xl md:px-4">
      <a
        href="/"
        className="mr-1 hidden text-sm font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70 sm:block"
      >
        Replixo
      </a>

      <div className="ml-auto flex items-center gap-2">
        {/* Добавить в друзья */}
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground" />
            }
          >
            <UserPlus className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Добавить в друзья</span>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Добавить в друзья</DialogTitle>
              <DialogDescription>
                Введите username — человек получит заявку и сможет её принять.
              </DialogDescription>
            </DialogHeader>
            <AddFriendForm />
          </DialogContent>
        </Dialog>

        {/* Заявки */}
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm" className="relative gap-1.5 text-muted-foreground hover:text-foreground" />
            }
          >
            <Inbox className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Заявки</span>
            {pending.length > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
                aria-label={`${pending.length} входящих заявок`}
              >
                {pending.length > 99 ? '99+' : pending.length}
              </span>
            )}
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Заявки в друзья</DialogTitle>
              <DialogDescription>
                Входящие заявки нужно принять, исходящие можно отменить.
              </DialogDescription>
            </DialogHeader>

            <div className="flex gap-1 rounded-lg border border-border/60 bg-secondary/20 p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setRequestsTab(tab.id)}
                  aria-current={requestsTab === tab.id ? 'true' : undefined}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    requestsTab === tab.id
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {requestsTab === 'incoming' ? (
                <PendingRequests pending={pending} isLoading={pendingLoading} />
              ) : (
                <SentRequests sent={sent} isLoading={sentLoading} />
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Состояние соединения: без него непонятно, почему сообщения не уходят */}
        {unavailable ? (
          <span className="ml-1 text-xs text-destructive">Чат недоступен</span>
        ) : (
          <span className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                'size-2 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
              aria-hidden="true"
            />
            <span className="hidden md:inline">{connected ? 'На связи' : 'Подключение…'}</span>
          </span>
        )}
      </div>
    </header>
  )
}
