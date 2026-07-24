import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ProfileClient } from './profile-client'

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl bg-background px-6 py-16">
      <ProfileClient user={session.user} />
    </main>
  )
}
