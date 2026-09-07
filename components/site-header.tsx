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
      {/* 1fr / auto / 1fr: крайние колонки делят свободное место поровну, поэтому
          nav стоит по центру страницы даже когда справа контента больше, чем слева.
          На мобильных nav скрыт, там хватает обычного flex + justify-between. */}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 md:grid md:grid-cols-[1fr_auto_1fr]">
        <div className="flex justify-start">
          <Logo />
        </div>
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
        <div className="flex items-center justify-end gap-2">
          <AuthButtons user={user} />
        </div>
      </div>
    </header>
  )
}
