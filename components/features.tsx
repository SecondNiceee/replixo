import Link from "next/link"
import { ArrowRight, Infinity as InfinityIcon, MonitorUp, PenLine, Sparkles, UserRoundCheck } from "lucide-react"
import { Reveal } from "@/components/reveal"

const cardBase =
  "group flex h-full flex-col gap-5 rounded-2xl border border-border bg-card p-6 shadow-[0_1px_2px_oklch(0.2_0.02_265/0.04),0_12px_32px_-16px_oklch(0.2_0.02_265/0.18)] transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_1px_2px_oklch(0.2_0.02_265/0.06),0_20px_40px_-16px_oklch(0.2_0.02_265/0.26)]"

function IconBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-foreground">
      {children}
    </span>
  )
}

function CardText({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
    </div>
  )
}

function WhiteboardVisual() {
  return (
    <div aria-hidden="true" className="relative flex h-28 flex-col justify-center gap-2 overflow-hidden rounded-xl border border-border bg-secondary/60 px-4 font-mono text-sm text-foreground/80">
      <span>{"S = a · b"}</span>
      <span>{"P = 2(a + b)"}</span>
      <span className="absolute bottom-3 right-4 h-10 w-16 rounded-sm border-2 border-dashed border-foreground/30" />
    </div>
  )
}

function TimerVisual() {
  return (
    <div aria-hidden="true" className="flex h-28 items-center justify-center gap-4 rounded-xl border border-border bg-secondary/60">
      <span className="font-mono text-2xl text-muted-foreground line-through decoration-2">40:00</span>
      <ArrowRight className="size-5 text-muted-foreground" />
      <InfinityIcon className="size-10 text-foreground" strokeWidth={1.75} />
    </div>
  )
}

function ScreenVisual() {
  return (
    <div aria-hidden="true" className="flex h-28 flex-col overflow-hidden rounded-xl border border-border bg-secondary/60">
      <div className="flex gap-1.5 border-b border-border px-3 py-2">
        <span className="size-2 rounded-full bg-foreground/20" />
        <span className="size-2 rounded-full bg-foreground/20" />
        <span className="size-2 rounded-full bg-foreground/20" />
      </div>
      <div className="flex flex-1 flex-col justify-center gap-2 px-4">
        <span className="h-2 w-3/4 rounded-full bg-foreground/15" />
        <span className="h-2 w-1/2 rounded-full bg-foreground/15" />
        <span className="h-2 w-2/3 rounded-full bg-foreground/15" />
      </div>
    </div>
  )
}

function CodeVisual() {
  return (
    <div aria-hidden="true" className="flex h-28 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-secondary/60">
      <span className="text-xs text-muted-foreground">Код урока</span>
      <div className="flex gap-1.5">
        {"K7M2Q9".split("").map((char, index) => (
          <span
            key={index}
            className="flex size-8 items-center justify-center rounded-md border border-border bg-card font-mono text-sm font-medium text-foreground"
          >
            {char}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Features() {
  return (
    <section className="border-t border-border py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">Возможности</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Что умеет Replixo
          </h2>
          <p className="mt-3 text-pretty text-base leading-relaxed text-muted-foreground">
            Всё, что обычно нужно на занятии, работает в браузере на компьютере и телефоне.
          </p>
        </Reveal>

        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-6">
          <Reveal className="md:col-span-6">
            <article className={`${cardBase} bg-primary text-primary-foreground md:flex-row md:items-center md:justify-between md:gap-10 md:p-8`}>
              <div className="flex max-w-2xl flex-col gap-4">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary-foreground/10">
                  <Sparkles className="size-5" />
                </span>
                <div className="flex flex-col gap-2">
                  <h3 className="text-xl font-medium sm:text-2xl">ИИ-конспект урока</h3>
                  <p className="text-pretty text-sm leading-relaxed text-primary-foreground/70 sm:text-base">
                    Включите запись во время занятия, а после урока получите подробный конспект. Его можно
                    отредактировать, скачать в PDF и отправить ученику в чат.
                  </p>
                </div>
              </div>
              <Link
                href="/sign-up"
                className="inline-flex shrink-0 items-center gap-2 self-start rounded-full bg-primary-foreground px-5 py-2.5 text-sm font-medium text-primary transition-opacity hover:opacity-90 md:self-center"
              >
                Попробовать
                <ArrowRight className="size-4" />
              </Link>
            </article>
          </Reveal>

          <Reveal className="md:col-span-3 lg:col-span-4" delay={80}>
            <article className={cardBase}>
              <IconBadge>
                <PenLine className="size-5" />
              </IconBadge>
              <CardText
                title="Доска и рисование поверх экрана"
                description="Пишите формулы, рисуйте схемы и разбирайте задачи. Ученик видит всё сразу."
              />
              <WhiteboardVisual />
            </article>
          </Reveal>

          <Reveal className="md:col-span-3 lg:col-span-2" delay={160}>
            <article className={cardBase}>
              <IconBadge>
                <InfinityIcon className="size-5" />
              </IconBadge>
              <CardText
                title="Урок без таймера"
                description="Связь не обрывается через 40 минут. Занимайтесь столько, сколько нужно."
              />
              <TimerVisual />
            </article>
          </Reveal>

          <Reveal className="md:col-span-3" delay={80}>
            <article className={cardBase}>
              <IconBadge>
                <MonitorUp className="size-5" />
              </IconBadge>
              <CardText
                title="Демонстрация экрана"
                description="Показывайте презентации, учебники и упражнения прямо во время занятия."
              />
              <ScreenVisual />
            </article>
          </Reveal>

          <Reveal className="md:col-span-3" delay={160}>
            <article className={cardBase}>
              <IconBadge>
                <UserRoundCheck className="size-5" />
              </IconBadge>
              <CardText
                title="Ученику не нужен аккаунт"
                description="Достаточно кода урока. Ребёнок заходит из браузера, ничего не устанавливая."
              />
              <CodeVisual />
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
