const points = [
  "Видео до 1080p",
  "Чистый звук",
  "Без водяных знаков и рекламы",
  "Бесплатно для учителя и ученика",
]

export function QualityBanner() {
  return (
    <section className="px-6 pb-16 sm:pb-20">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 rounded-lg border border-border bg-card p-8 sm:p-12 md:flex-row md:items-end md:justify-between">
        <div className="max-w-xl">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Качество видео без платных тарифов
          </h2>
          <p className="mt-3 text-pretty text-base leading-relaxed text-muted-foreground">
            Full HD доступно всем сразу. Чтобы картинка была чёткой, ничего
            покупать не нужно.
          </p>
        </div>

        <ul className="flex flex-col gap-2 text-sm text-foreground md:min-w-64">
          {points.map((point) => (
            <li key={point} className="border-b border-border pb-2 last:border-b-0 last:pb-0">
              {point}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
