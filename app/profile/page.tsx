import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { SiteHeader } from '@/components/site-header'
import { ProfileClient } from './profile-client'

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 pt-28 pb-16">
        <ProfileClient user={session.user} />
      </main>
    </div>
  )
}
