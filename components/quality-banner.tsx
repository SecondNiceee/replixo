import { Check, Sparkles } from "lucide-react"

const points = [
  "Чёткое видео Full HD 1080p",
  "Кристально чистый звук",
  "Без водяных знаков и рекламы",
  "Доступно каждому участнику",
]

export function QualityBanner() {
  return (
    <section className="relative px-6 pb-16 sm:pb-20">
      <div className="mx-auto max-w-6xl">
        <div className="relative overflow-hidden rounded-[2rem] border border-border bg-card px-6 py-16 text-center sm:px-12 sm:py-24">
          {/* glow */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,oklch(0.24_0_0)_0%,transparent_70%)] blur-3xl"
          />
          {/* faint grid */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:40px_40px]"
          />

          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-4 py-1.5 text-xs font-medium text-foreground">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Качество видео
          </span>

          <h2 className="mx-auto mt-8 max-w-3xl text-balance text-5xl font-semibold leading-[1.02] tracking-tight text-foreground sm:text-6xl md:text-7xl">
            Видео в 1080p
          </h2>

          {/* big free badge */}
          <div className="mt-6 flex items-center justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-foreground/20 bg-foreground px-6 py-2.5 text-lg font-bold uppercase tracking-wide text-background sm:text-xl">
              Бесплатно
            </span>
          </div>

          <p className="mx-auto mt-8 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Никаких платных тарифов ради нормальной картинки. Full HD доступно
            всем и сразу — просто начните звонок.
          </p>

          <ul className="mx-auto mt-12 grid max-w-2xl grid-cols-1 gap-3 text-left sm:grid-cols-2">
            {points.map((point) => (
              <li
                key={point}
                className="inline-flex items-center gap-3 rounded-2xl border border-border bg-secondary/30 px-4 py-3.5 text-sm font-medium text-foreground"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                  <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
