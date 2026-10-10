import Link from "next/link"
import { Logo } from "@/components/logo"
import { SiteFooter } from "@/components/site-footer"
import { LEGAL_UPDATED_AT } from "@/lib/legal"

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center px-6 py-6">
        <Link href="/?landing=1" aria-label="На главную">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16">
        <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Редакция от {LEGAL_UPDATED_AT}</p>
        <article className="mt-10 flex flex-col gap-10">{children}</article>
      </main>
      <SiteFooter />
    </div>
  )
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground md:text-base">{children}</div>
    </section>
  )
}

export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-muted-foreground">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

export function LegalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-foreground underline underline-offset-4 hover:text-primary">
      {children}
    </Link>
  )
}
