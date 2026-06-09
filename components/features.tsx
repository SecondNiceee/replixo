import {
  ShieldOff,
  MonitorPlay,
  Infinity as InfinityIcon,
  Download,
  Lock,
  Zap,
} from "lucide-react"

const features = [
  {
    icon: ShieldOff,
    title: "Работает без VPN",
    description:
      "Прямое соединение между участниками. Никаких блокировок, прокси и обходных путей — просто откройте ссылку.",
    featured: true,
    badge: "Без VPN",
  },
  {
    icon: InfinityIcon,
    title: "Без ограничений по времени",
    description:
      "Ни таймеров, ни автоотключений на 40 минутах. Разговаривайте столько, сколько нужно.",
  },
  {
    icon: Download,
    title: "Без установки приложений",
    description:
      "Всё работает прямо в браузере. Не нужно ничего скачивать ни вам, ни вашим собеседникам.",
  },
  {
    icon: Lock,
    title: "Приватность по умолчанию",
    description:
      "Соединения шифруются, а комнаты доступны только по коду. Ваши разговоры остаются вашими.",
  },
  {
    icon: Zap,
    title: "Подключение в один клик",
    description:
      "Создайте комнату или войдите по коду за пару секунд. Без регистрации и долгих настроек.",
  },
  {
    icon: MonitorPlay,
    title: "Демонстрация экрана",
    description:
      "Делитесь экраном в высоком качестве для презентаций, созвонов и совместной работы.",
  },
]

export function Features() {
  return (
    <section className="relative border-t border-border px-6 py-16 sm:py-20">
      {/* subtle glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[400px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,oklch(0.2_0_0)_0%,transparent_70%)] blur-3xl"
      />

      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            Преимущества
          </span>
          <h2 className="mt-6 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
            Всё для общения. Ничего лишнего.
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Видеозвонки, которые просто работают — где угодно и без компромиссов.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className={`group relative flex flex-col gap-4 overflow-hidden rounded-3xl border p-8 transition-all duration-300 ${
                feature.featured
                  ? "border-foreground/20 bg-gradient-to-br from-secondary/60 to-card sm:col-span-2 lg:col-span-1"
                  : "border-border bg-card hover:-translate-y-1 hover:border-foreground/15"
              }`}
            >
              {/* hover sheen */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-foreground/[0.04] opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
              />

              <div className="flex items-center justify-between">
                <div
                  className={`flex size-12 items-center justify-center rounded-2xl border transition-colors ${
                    feature.featured
                      ? "border-foreground/20 bg-foreground text-background"
                      : "border-border bg-secondary/50 text-foreground group-hover:bg-secondary"
                  }`}
                >
                  <feature.icon className="size-6" strokeWidth={2} aria-hidden="true" />
                </div>
                {feature.badge ? (
                  <span className="rounded-full border border-foreground/20 bg-foreground/5 px-3 py-1 text-xs font-medium text-foreground">
                    {feature.badge}
                  </span>
                ) : null}
              </div>

              <h3 className="text-lg font-semibold text-foreground">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
