import { headers } from 'next/headers'
import { Download } from 'lucide-react'
import { auth } from '@/lib/auth'
import { Logo } from "@/components/logo"
import { AuthButtons } from "@/components/auth-buttons"

const MEDIASOUP_URL =
  process.env.NEXT_PUBLIC_MEDIASOUP_URL ?? 'http://localhost:3001'

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
        </nav>
        <div className="flex items-center gap-2">
          <a
            href={`${MEDIASOUP_URL}/download/windows`}
            download="Replixo-Setup-version-1.exe"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-95"
          >
            <Download className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Скачать для Windows</span>
            <span className="sm:hidden">Скачать</span>
          </a>
          <span className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs font-medium text-foreground">
            RU
          </span>
          <AuthButtons user={user} />
        </div>
      </div>
    </header>
  )
}
