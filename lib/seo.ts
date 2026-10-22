import type { Metadata } from "next"
import { OPERATOR } from "@/lib/legal"

export const SITE_URL = OPERATOR.site
export const SITE_NAME = "Replixo"

// Вложенный openGraph в Next.js заменяет родительский целиком, а не сливается
// с ним, — поэтому siteName и locale собираются здесь для каждой страницы.
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "ru_RU",
      siteName: SITE_NAME,
      url: path,
      title: `${title} — ${SITE_NAME}`,
      description,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} — ${SITE_NAME}`,
      description,
    },
  }
}

export const NO_INDEX: Metadata["robots"] = {
  index: false,
  follow: false,
  googleBot: { index: false, follow: false },
}
