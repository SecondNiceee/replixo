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
  {
    title: "Работает без VPN",
    description:
      "Сервис доступен из России, урок можно начать сразу.",
  },
  {
    title: "ИИ-конспект урока",
    description:
      "После занятия получите конспект в PDF и отправьте его ученику в чат. Нужна регистрация.",
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

        <dl className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 border-t border-border pt-10 sm:grid-cols-2 lg:grid-cols-3">
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
