"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SITE_LINKS } from "@/components/site-nav"
import { cn } from "@/lib/utils"

export function MobileNav({ className }: { className?: string }) {
  const pathname = usePathname()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Открыть меню"
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Menu className="size-5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        {SITE_LINKS.map((link) => {
          const active = pathname === link.path
          return (
            <DropdownMenuItem
              key={link.href}
              render={<Link href={link.href} aria-current={active ? "page" : undefined} />}
              className={cn("py-2.5 text-sm", active ? "text-foreground" : "text-muted-foreground")}
            >
              {link.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
