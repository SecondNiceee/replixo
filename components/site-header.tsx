import { headers } from 'next/headers'
import Link from "next/link"
import { auth } from '@/lib/auth'
import { Logo } from "@/components/logo"
import { AuthButtons } from "@/components/auth-buttons"
import { HOME_HREF, SiteNav } from "@/components/site-nav"

export async function SiteHeader() {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
    ? { name: session.user.name, email: session.user.email }
    : null

  return (
    <header className="absolute inset-x-0 top-0 z-20">
      {/* minmax(0,1fr) / auto / minmax(0,1fr): крайние колонки делят свободное
          место строго поровну, поэтому nav стоит по центру страницы даже когда
          справа контента больше, чем слева. Голый 1fr не может стать уже своего
          контента — с ним широкая правая группа расширяла колонку и сдвигала
          nav. На мобильных nav скрыт, там хватает обычного flex + justify-between. */}
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-x-6">
        <div className="flex justify-start">
          <Link href={HOME_HREF} aria-label="Replixo — на главную" className="rounded-md">
            <Logo />
          </Link>
        </div>
        <SiteNav className="hidden lg:flex" />
        <div className="flex items-center justify-end gap-2">
          <AuthButtons user={user} />
        </div>
      </div>
    </header>
  )
}
