"use client"

import { ThemeProvider as NextThemesProvider } from "next-themes"
import { usePathname } from "next/navigation"
import type { ComponentProps } from "react"

export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  const pathname = usePathname()
  // Комната звонка всегда тёмная: видео и оверлеи рассчитаны на тёмный фон.
  // forcedTheme не трогает сохранённый выбор — после выхода из комнаты
  // вернётся тема, которую выбрал пользователь.
  const forcedTheme = pathname?.startsWith("/room") ? "dark" : undefined

  return <NextThemesProvider {...props} forcedTheme={forcedTheme} />
}
