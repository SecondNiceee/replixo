"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

// ?landing=1 — чтобы авторизованного пользователя не редиректило в кабинет.
export const HOME_HREF = "/?landing=1"

export const SITE_LINKS = [
  { href: HOME_HREF, path: "/", label: "Главная" },
  { href: "/app-download", path: "/app-download", label: "Приложение" },
  { href: "/ai-notes", path: "/ai-notes", label: "ИИ-конспекты" },
  { href: "/examples", path: "/examples", label: "Примеры конспектов" },
  { href: "/company", path: "/company", label: "Компания" },
]

export function SiteNav({ className }: { className?: string }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Основное меню" className={cn("items-center gap-6 text-sm lg:gap-7", className)}>
      {SITE_LINKS.map((link) => {
        const active = pathname === link.path
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap transition-colors hover:text-foreground",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
