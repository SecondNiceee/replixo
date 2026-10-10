import type { Metadata } from "next"
import Link from "next/link"
import { MarketingPage } from "@/components/marketing/marketing-page"
import { ExampleNotesViewer } from "@/components/marketing/example-notes-viewer"

export const metadata: Metadata = {
  title: "Примеры ИИ-конспектов уроков — Replixo",
  description: "Посмотрите и скачайте в PDF примеры конспектов, которые Replixo составляет по уроку: алгебра, английский, физика.",
}

export default function ExamplesPage() {
  return (
    <MarketingPage
      eyebrow="Примеры конспектов"
      title="Так выглядит конспект после урока"
      lead={
        <p>
          Три реальных по формату примера: алгебра, английский и физика. Каждый можно открыть здесь или
          скачать в PDF. Свой конспект вы получите после{" "}
          <Link href="/sign-up" className="text-foreground underline underline-offset-4 hover:text-primary">
            регистрации
          </Link>
          .
        </p>
      }
    >
      <ExampleNotesViewer />
    </MarketingPage>
  )
}
