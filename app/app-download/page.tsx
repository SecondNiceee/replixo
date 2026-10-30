import { pageMetadata } from "@/lib/seo"
import type { Metadata } from 'next'
import { Download, Laptop, ShieldCheck } from 'lucide-react'
import { SiteHeader } from '@/components/site-header'

export const metadata: Metadata = pageMetadata({
  title: 'Приложение для Windows',
  description:
    'Скачайте бесплатное приложение Replixo для Windows и проводите онлайн-уроки прямо с рабочего стола. Браузерная версия работает без установки.',
  path: '/app-download',
})

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
              download="Replixo-Setup-version-4.exe"
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

          <section
            aria-labelledby="smartscreen-title"
            className="flex w-full flex-col gap-4 rounded-lg border border-border bg-card p-6 text-left"
          >
            <h2
              id="smartscreen-title"
              className="text-base font-semibold text-card-foreground"
            >
              Почему Windows предупреждает при установке?
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Windows Defender SmartScreen проверяет, насколько часто программу
              скачивают. Replixo — новое приложение, у него пока мало загрузок,
              поэтому фильтр показывает окно «Система Windows защитила ваш
              компьютер». Это не значит, что в файле есть вирус: так Windows
              реагирует на любые новые программы, пока у них не наберётся
              достаточно скачиваний.
            </p>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-card-foreground">
                Как установить:
              </p>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                <li>В окне предупреждения нажмите «Подробнее».</li>
                <li>Нажмите появившуюся кнопку «Выполнить в любом случае».</li>
                <li>Дальше установка пройдёт как обычно.</li>
              </ol>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Не хотите ничего устанавливать — пользуйтесь Replixo прямо в
              браузере, все функции там тоже доступны.
            </p>
          </section>

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
