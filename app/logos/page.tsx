import type { Metadata } from 'next'
import { logoConcepts } from './logo-marks'

export const metadata: Metadata = {
  title: 'Логотипы — Replixo',
  description: 'Девять вариантов знака Replixo для выбора.',
}

/**
 * Витрина знаков: девять вариантов логотипа Replixo.
 *
 * Служебная страница выбора, не часть продукта. Поэтому она устроена как
 * типографский лист, а не как раздел приложения: никаких градиентных сцен и
 * стеклянных панелей — они бы «продавали» карточку вместо самого знака.
 *
 * Каждый вариант показан трижды, потому что логотип проверяется не в вакууме:
 * крупно (пропорции и штрих), в акцентном квадрате 24px (как в шапке кабинета)
 * и в подписи рядом со словом (реальная связка знак + название). Вариант,
 * который хорош только крупно, отсюда сразу виден.
 */
export default function LogosPage() {
  return (
    <main className="app-dark min-h-dvh bg-background px-6 py-16 md:px-10 md:py-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-14">
        <header className="flex max-w-2xl flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Replixo / выбор знака
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            Девять вариантов логотипа
          </h1>
          <p className="text-pretty text-base leading-relaxed text-muted-foreground">
            Каждый знак нарисован в сетке 48×48 и наследует цвет темы, поэтому одинаково
            работает на светлом лендинге, в тёмном кабинете и в иконке приложения. Назовите
            номер — поставим его в шапку, кабинет и favicon.
          </p>
        </header>

        {/* Три колонки максимум: на четырёх знак стал бы мелким, а именно
            крупный показ — главное, зачем эта страница нужна. */}
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {logoConcepts.map(({ id, name, idea, Mark }) => (
            <section key={id} className="flex flex-col gap-6 bg-card p-7">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  {name}
                </h2>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {id}
                </span>
              </div>

              {/* Крупный показ: знак в акцентном цвете на подложке страницы —
                  так проверяются пропорции и толщина штриха. */}
              <div className="flex items-center justify-center rounded-xl border border-border/70 bg-background py-10">
                <Mark className="size-20 text-primary" />
              </div>

              <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
                {idea}
              </p>

              {/* Две рабочие ситуации подряд: залитый квадрат 24px, как в шапке
                  кабинета, и подпись со словом. */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-4 border-t border-border/70 pt-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Mark className="size-5" />
                  </span>
                  <span className="text-lg font-semibold tracking-tight text-foreground">
                    Replixo
                  </span>
                </div>

                {/* Мелкий контроль: 16px без подложки — размер favicon. Знак,
                    который здесь превращается в пятно, на иконку не пойдёт. */}
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mark className="size-4 text-foreground" />
                  <span className="font-mono text-[11px] uppercase tracking-wider">16px</span>
                </div>
              </div>
            </section>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">
          Выбранный вариант заменит знак в{' '}
          <code className="font-mono text-xs text-foreground">components/logo.tsx</code>, шапке
          кабинета и иконках приложения.
        </p>
      </div>
    </main>
  )
}
