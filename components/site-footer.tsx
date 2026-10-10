import Link from "next/link"
import { LEGAL_LINKS, OPERATOR } from "@/lib/legal"

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 text-sm text-muted-foreground md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">© {new Date().getFullYear()} Replixo</p>
          <p>
            {OPERATOR.fullName}, самозанятый
          </p>
          <p>ИНН {OPERATOR.inn}</p>
          <a href={`mailto:${OPERATOR.email}`} className="hover:text-foreground">
            {OPERATOR.email}
          </a>
        </div>
        <nav aria-label="Документы" className="flex flex-col gap-2 md:items-end">
          {LEGAL_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="transition-colors hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  )
}
