import { SiteHeader } from "@/components/site-header"
import { Hero } from "@/components/hero"
import { Features } from "@/components/features"
import { QualityBanner } from "@/components/quality-banner"

export default function Page() {
  return (
    <main className="relative min-h-screen bg-background">
      <SiteHeader />
      <Hero />
      <Features />
      <QualityBanner />
    </main>
  )
}
