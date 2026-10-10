import type { ReactNode } from "react"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { SiteNav } from "@/components/site-nav"

export function MarketingPage({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string
  title: string
  lead: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1 pt-24">
        <SiteNav className="flex overflow-x-auto px-6 pb-2 lg:hidden" />
        <header className="mx-auto flex max-w-5xl flex-col gap-5 px-6 pb-16 pt-12 sm:pt-20">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
            {title}
          </h1>
          <div className="max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">{lead}</div>
        </header>
        {children}
      </main>
      <SiteFooter />
    </div>
  )
}

/** Секция в две колонки: заголовок слева, содержимое справа. */
export function MarketingSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="border-t border-border px-6 py-14 sm:py-20">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <h2 id={id} className="text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h2>
        <div className="flex flex-col gap-6 text-pretty text-base leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </section>
  )
}

export function FactList({ items }: { items: { title: string; text: string }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="flex flex-col gap-2 border-t border-border pt-4">
          <dt className="font-medium text-foreground">{item.title}</dt>
          <dd className="text-sm leading-relaxed">{item.text}</dd>
        </div>
      ))}
    </dl>
  )
}
