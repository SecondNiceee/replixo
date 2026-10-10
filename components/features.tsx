import Link from "next/link"

const features = [
  {
    title: "Доска и рисование поверх экрана",
    description:
      "Пишите формулы, рисуйте схемы и разбирайте задачи. Ученик видит всё сразу.",
  },
  {
    title: "Урок без таймера",
    description:
      "Связь не обрывается через 40 минут. Занимайтесь столько, сколько нужно.",
  },
  {
    title: "Демонстрация экрана",
    description:
      "Показывайте презентации, учебники и упражнения прямо во время занятия.",
  },
  {
    title: "Ученику не нужен аккаунт",
    description:
      "Достаточно кода урока. Ребёнок заходит из браузера, ничего не устанавливая.",
  },
]

export function Features() {
  return (
    <section className="border-t border-border px-6 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl">
        <div className="max-w-2xl">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Что умеет Replixo
          </h2>
          <p className="mt-3 text-pretty text-base leading-relaxed text-muted-foreground">
            Всё, что обычно нужно на занятии, работает в браузере на компьютере
            и телефоне.
          </p>
        </div>

        <div className="mt-10 flex flex-col gap-4 rounded-lg border border-foreground/25 bg-secondary/60 p-6 shadow-[0_0_40px_-12px_oklch(1_0_0/0.18)] sm:flex-row sm:items-end sm:justify-between sm:gap-10 sm:p-8">
          <div className="flex max-w-2xl flex-col gap-2">
            <h3 className="text-lg font-medium text-foreground sm:text-xl">
              ИИ-конспект урока
            </h3>
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
              Включите запись во время занятия, а после урока получите подробный
              конспект. Его можно отредактировать, скачать в PDF и отправить
              ученику в чат.
            </p>
          </div>
          <Link
            href="/sign-up"
            className="shrink-0 text-sm font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground"
          >
            Нужна регистрация
          </Link>
        </div>

        <dl className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature.title} className="flex flex-col gap-2">
              <dt className="text-base font-medium text-foreground">{feature.title}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
