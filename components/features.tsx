import { Infinity as InfinityIcon, MonitorUp, PenLine, Sparkles, UserRoundCheck, Video } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Reveal } from "@/components/reveal"

const features: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Sparkles,
    title: "ИИ-конспект урока",
    description: "После занятия вы получаете подробный конспект, который можно поправить и отправить ученику.",
  },
  {
    icon: InfinityIcon,
    title: "Без ограничения по времени",
    description: "Связь не обрывается через 40 минут. Занимайтесь столько, сколько нужно.",
  },
  {
    icon: PenLine,
    title: "Доска и рисование",
    description: "Пишите формулы, рисуйте схемы и разбирайте задачи, ученик видит всё сразу.",
  },
  {
    icon: MonitorUp,
    title: "Демонстрация экрана",
    description: "Показывайте презентации, учебники и упражнения прямо во время урока.",
  },
  {
    icon: UserRoundCheck,
    title: "Ученику не нужен аккаунт",
    description: "Достаточно кода урока. Ученик заходит из браузера и ничего не устанавливает.",
  },
  {
    icon: Video,
    title: "Работает в браузере",
    description: "На компьютере и телефоне, без программ и расширений.",
  },
]

export function Features() {
  return (
    <section className="border-t border-border py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal className="max-w-2xl">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Что умеет Replixo
          </h2>
          <p className="mt-3 text-pretty text-base leading-relaxed text-muted-foreground">
            Всё, что обычно нужно на занятии.
          </p>
        </Reveal>

        <ul className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, description }, index) => (
            <li key={title}>
              <Reveal delay={(index % 3) * 60} className="flex gap-4">
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-foreground" strokeWidth={1.75} />
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-base font-medium text-foreground">{title}</h3>
                  <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
