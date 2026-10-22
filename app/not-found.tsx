import type { Metadata } from "next"
import Link from "next/link"
import { ReplixoMark } from "@/components/replixo-mark"
import { buttonVariants } from "@/components/ui/button"
import { NO_INDEX } from "@/lib/seo"
import { OPERATOR } from "@/lib/legal"

export const metadata: Metadata = {
  title: "Страница не найдена",
  robots: NO_INDEX,
}

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col bg-background px-6">
      <header className="mx-auto flex w-full max-w-6xl items-center py-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ReplixoMark className="size-8 text-primary" />
          <span className="text-lg font-semibold tracking-tight text-foreground">Replixo</span>
        </Link>
      </header>

      <section
        aria-labelledby="not-found-title"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-8 py-16 text-center"
      >
        <div className="relative flex items-center justify-center">
          <ReplixoMark className="size-40 text-foreground/10 sm:size-52" />
          <span className="absolute font-mono text-sm tracking-[0.3em] text-muted-foreground">
            404
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <h1
            id="not-found-title"
            className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
          >
            Такой страницы нет
          </h1>
          <p className="text-pretty leading-relaxed text-muted-foreground">
            Возможно, ссылка устарела или в адресе опечатка. Если вы шли на урок,
            попросите преподавателя прислать код комнаты ещё раз.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <Link href="/" className={buttonVariants({ size: "lg" })}>
            На главную
          </Link>
          <Link href="/ai-notes" className={buttonVariants({ size: "lg", variant: "outline" })}>
            ИИ-конспекты
          </Link>
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl py-6 text-center text-sm text-muted-foreground">
        {"Нужна помощь? "}
        <a
          href={`mailto:${OPERATOR.email}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {OPERATOR.email}
        </a>
      </footer>
    </main>
  )
}
