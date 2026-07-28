import type { Metadata } from 'next'
import { Download, Laptop, ShieldCheck } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'

export const metadata: Metadata = {
  title: 'Приложение Replixo для Windows',
  description:
    'Скачайте приложение Replixo для Windows и начинайте видеозвонки прямо с рабочего стола.',
}

export default function AppDownloadPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      <SiteHeader />

      <section className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6 pb-16 pt-32 text-center">
        <div className="flex max-w-3xl flex-col items-center gap-8">
          <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-card shadow-lg shadow-background">
            <Laptop className="size-8" aria-hidden="true" />
          </div>

          <div className="flex flex-col items-center gap-4">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Replixo для компьютера
            </p>
            <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl md:text-6xl">
              Всегда на связи. Прямо с рабочего стола.
            </h1>
            <p className="max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
              Установите Replixo на Windows, чтобы быстрее начинать звонки и
              оставаться на связи без открытой вкладки браузера.
            </p>
          </div>

          <div className="flex flex-col items-center gap-4">
            <a
              href="/download/windows"
              download="Replixo-Setup-version-3.exe"
              className="inline-flex h-14 items-center justify-center gap-3 rounded-xl bg-primary px-7 text-base font-medium text-primary-foreground transition-all hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring active:scale-[0.98]"
            >
              <Download className="size-5" aria-hidden="true" />
              Скачать для Windows
            </a>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Установщик для Windows
            </p>
          </div>

          <div className="w-full border-t border-border pt-8">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Приложение для других операционных систем находится в разработке.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
