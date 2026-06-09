import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"

export function SiteHeader() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="#" className="transition-colors hover:text-foreground">
            Возможности
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            Тарифы
          </a>
          <a href="#" className="transition-colors hover:text-foreground">
            Компания
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs font-medium text-foreground">
            RU
          </span>
          <Button
            variant="ghost"
            className="text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Войти
          </Button>
        </div>
      </div>
    </header>
  )
}
