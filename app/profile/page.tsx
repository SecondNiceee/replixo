import { Suspense } from 'react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ProfileClient } from './profile-client'

export const metadata: Metadata = {
  title: 'Кабинет — Replixo',
  description: 'Личные сообщения и друзья в Replixo.',
}

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  return (
    // h-dvh + flex: переписка должна скроллиться внутри своей колонки, а не
    // растягивать страницу — иначе композер уезжает за нижний край экрана.
    // app-light включает светлую палитру только здесь: лендинг и комнаты
    // свёрстаны под тёмный :root.
    <main className="app-light app-shell-surface flex h-dvh flex-col overflow-hidden px-3 py-3 md:px-5 md:py-5">
      {/* ProfileClient читает ?c= и ?u= через useSearchParams — на сервере это
          требует Suspense. */}
      <Suspense fallback={null}>
        <ProfileClient user={session.user} />
      </Suspense>
    </main>
  )
}
