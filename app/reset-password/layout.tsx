import type { Metadata } from "next"
import { NO_INDEX } from "@/lib/seo"

export const metadata: Metadata = {
  title: "Новый пароль",
  robots: NO_INDEX,
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children
}
