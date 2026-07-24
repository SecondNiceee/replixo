import { Suspense } from 'react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ChatClient } from './chat-client'

export const metadata: Metadata = {
  title: 'Сообщения — Replixo',
  description: 'Личные сообщения с друзьями в Replixo.',
}

export default async function ChatPage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  return (
    <main className="mx-auto flex h-dvh max-w-6xl flex-col px-4 py-4 md:px-6 md:py-6">
      <Suspense fallback={null}>
        <ChatClient selfId={session.user.id} />
      </Suspense>
    </main>
  )
}
