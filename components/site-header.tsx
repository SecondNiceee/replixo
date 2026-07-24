import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { Logo } from "@/components/logo"
import { AuthButtons } from "@/components/auth-buttons"

export async function SiteHeader() {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
    ? { name: session.user.name, email: session.user.email }
    : null

  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="#" className="transition-colors hover:text-foreground">
            Возможности
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            Тарифы
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            Компания
          </a>
          <a
            href="/app-download"
            className="transition-colors hover:text-foreground"
          >
            Приложение
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <AuthButtons user={user} />
        </div>
      </div>
    </header>
  )
}
