import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { SiteHeader } from '@/components/site-header'
import { UserPlus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/sign-in')
  }

  const user = session.user

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-5xl px-6 pt-28 pb-16">
        {/* Шапка профиля */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-full bg-secondary text-2xl font-semibold text-foreground">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">{user.name}</h1>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <UserPlus className="size-4" />
            Добавить в друзья
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
          {/* Боковая панель — список друзей */}
          <aside className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Users className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-foreground">Друзья</h2>
            </div>
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Users className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Список друзей пуст</p>
              <p className="text-xs text-muted-foreground/60">
                Добавьте друзей, чтобы начать общение
              </p>
            </div>
          </aside>

          {/* Основной контент */}
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-sm font-medium text-foreground">Активность</h2>
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <p className="text-sm text-muted-foreground">Пока ничего нет</p>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
