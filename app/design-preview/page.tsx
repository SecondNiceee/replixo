'use client'

// ВРЕМЕННАЯ страница для визуальной проверки кабинета без базы и сокета.
// Удалить после правки дизайна.

import { Suspense } from 'react'
import { SWRConfig } from 'swr'
import { ProfileClient } from '@/app/profile/profile-client'

const now = Date.now()
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()

const friends = [
  { id: 'f1', friendId: 'u1', friendName: 'Марина Ковалёва', friendUsername: 'marina_k' },
  { id: 'f2', friendId: 'u2', friendName: 'Дмитрий', friendUsername: 'dmitry' },
  { id: 'f3', friendId: 'u3', friendName: 'Алексей Ветров', friendUsername: 'alexvetrov' },
  { id: 'f4', friendId: 'u4', friendName: 'Соня', friendUsername: 'sonya_dev' },
  { id: 'f5', friendId: 'u5', friendName: 'Костя', friendUsername: null },
  { id: 'f6', friendId: 'u6', friendName: 'Ирина Полякова', friendUsername: 'irina' },
  { id: 'f7', friendId: 'u7', friendName: 'Тимур', friendUsername: 'timur_99' },
]

const conversations = [
  {
    id: 'c1',
    friendId: 'u1',
    friendName: 'Марина Ковалёва',
    friendUsername: 'marina_k',
    unreadCount: 3,
    peerLastReadAt: null,
    lastMessageAt: iso(2),
    lastMessageText: 'Отправила правки по макету, глянь когда сможешь',
    lastMessageSenderId: 'u1',
  },
  {
    id: 'c2',
    friendId: 'u2',
    friendName: 'Дмитрий',
    friendUsername: 'dmitry',
    unreadCount: 0,
    peerLastReadAt: iso(30),
    lastMessageAt: iso(48),
    lastMessageText: 'Ок, созвон в 18:00',
    lastMessageSenderId: 'self',
  },
  {
    id: 'c3',
    friendId: 'u3',
    friendName: 'Алексей Ветров',
    friendUsername: 'alexvetrov',
    unreadCount: 12,
    peerLastReadAt: null,
    lastMessageAt: iso(190),
    lastMessageText: '',
    lastMessageAttachment: { url: '/x.pdf', name: 'brief-v2.pdf', size: 20480, mime: 'application/pdf' },
    lastMessageSenderId: 'u3',
  },
  {
    id: 'c4',
    friendId: 'u4',
    friendName: 'Соня',
    friendUsername: 'sonya_dev',
    unreadCount: 0,
    peerLastReadAt: null,
    lastMessageAt: iso(2000),
    lastMessageText: 'Нет сообщений',
    lastMessageSenderId: null,
  },
]

const pending = [
  { id: 'p1', requesterId: 'u9', requesterName: 'Егор', requesterUsername: 'egor' },
  { id: 'p2', requesterId: 'u10', requesterName: 'Лиза', requesterUsername: 'liza_m' },
]

const sent = [
  {
    id: 's1',
    addresseeId: 'u11',
    addresseeName: 'Павел',
    addresseeUsername: 'pavel',
    createdAt: iso(600),
  },
]

const fallback = {
  '/api/friends': {
    friends,
    presence: {
      statuses: { u1: 'online', u3: 'online', u4: 'idle', u6: 'online' },
      lastSeenAt: {
        u2: now - 4 * 60_000,
        u5: now - 3 * 3600_000,
        u7: now - 50 * 3600_000,
      },
    },
  },
  '/api/friends/pending': { pending },
  '/api/friends/sent': { sent },
  '/api/chat/conversations': { conversations },
}

export default function DesignPreviewPage() {
  return (
    <main className="app-dark app-shell-surface flex h-dvh flex-col overflow-hidden px-3 py-3 md:px-5 md:py-5">
      <SWRConfig value={{ fallback, revalidateOnMount: false, revalidateOnFocus: false }}>
        <Suspense fallback={null}>
          <ProfileClient
            user={{ id: 'self', name: 'annadesign', email: 'anna@replixo.app' }}
          />
        </Suspense>
      </SWRConfig>
    </main>
  )
}
