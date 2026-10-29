import type { Metadata } from "next"
import NotFound from "@/app/not-found"
import { AdminGate } from "@/components/admin/admin-gate"
import { NO_INDEX } from "@/lib/seo"

export const metadata: Metadata = {
  title: "Страница не найдена",
  robots: NO_INDEX,
}

export default function AdminPage() {
  return (
    <>
      <NotFound />
      <AdminGate />
    </>
  )
}
