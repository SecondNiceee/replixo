import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { SiteHeader } from "@/components/site-header"
import { Hero } from "@/components/hero"
import { Features } from "@/components/features"
import { LessonNotesShowcase } from "@/components/lesson-notes-showcase"
import { QualityBanner } from "@/components/quality-banner"
import { SiteFooter } from "@/components/site-footer"
import { Faq } from "@/components/faq"
import type { Metadata } from "next"
import { SITE_NAME, SITE_URL } from "@/lib/seo"
import { OPERATOR } from "@/lib/legal"

export const metadata: Metadata = {
  alternates: { canonical: "/" },
}

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
      email: OPERATOR.email,
    },
    {
      "@type": "WebSite",
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: "ru-RU",
    },
    {
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "EducationalApplication",
      operatingSystem: "Web, Windows",
      inLanguage: "ru-RU",
      offers: { "@type": "Offer", price: "0", priceCurrency: "RUB" },
    },
  ],
}

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
    <main className="landing-light relative min-h-screen overflow-hidden bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <div className="relative z-10">
        <SiteHeader />
        <Hero />
        <LessonNotesShowcase />
        <Features />
        <QualityBanner />
        <Faq />
        <SiteFooter />
      </div>
    </main>
  )
}
