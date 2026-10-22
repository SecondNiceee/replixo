import type { Metadata } from "next"
import { NO_INDEX } from "@/lib/seo"

export const metadata: Metadata = {
  title: "Превью дизайна",
  robots: NO_INDEX,
}

export default function DesignPreviewLayout({ children }: { children: React.ReactNode }) {
  return children
}
