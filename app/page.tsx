import { SiteHeader } from "@/components/site-header"
import { Hero } from "@/components/hero"
import { Features } from "@/components/features"
import { QualityBanner } from "@/components/quality-banner"

export default function Page() {
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
