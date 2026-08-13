import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { SiteHeader } from "@/components/site-header"
import { Hero } from "@/components/hero"
import { Features } from "@/components/features"
import { QualityBanner } from "@/components/quality-banner"

interface PageProps {
  searchParams: Promise<{ landing?: string }>
}

export default async function Page({ searchParams }: PageProps) {
  // Авторизованному человеку лендинг не нужен — его «домашняя» страница это
  // кабинет, поэтому редирект делаем на сервере, до отдачи разметки.
  // ?landing=1 — единственная лазейка: по нему из кабинета можно вернуться
  // на лендинг (тарифы, возможности, скачать приложение) без петли редиректов.
  const { landing } = await searchParams

  if (landing !== "1") {
    const session = await auth.api.getSession({ headers: await headers() })
    if (session?.user) {
      redirect("/profile")
    }
  }

  return (
    <main className="home-pattern relative min-h-screen overflow-hidden bg-background">
      <div className="relative z-10">
        <SiteHeader />
        <Hero />
        <Features />
        <QualityBanner />
      </div>
    </main>
  )
}
