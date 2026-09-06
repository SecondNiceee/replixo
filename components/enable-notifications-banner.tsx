'use client'

import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDesktopNotifications } from '@/lib/desktop-notifications'

/**
 * Предложение включить системные уведомления о сообщениях.
 *
 * Показывается только когда браузер ещё не спрашивал (`default`): после отказа
 * промпт всё равно не откроется, а после согласия предлагать нечего. Разрешение
 * запрашиваем строго по клику — на автоматический вызов при загрузке Chrome и
 * Firefox отвечают тихой блокировкой, и второго шанса уже не будет.
 */
export function EnableNotificationsBanner() {
  const permission = useDesktopNotifications((s) => s.permission)
  const dismissed = useDesktopNotifications((s) => s.dismissed)
  const sync = useDesktopNotifications((s) => s.sync)
  const request = useDesktopNotifications((s) => s.request)
  const dismiss = useDesktopNotifications((s) => s.dismiss)
  const [busy, setBusy] = useState(false)

  useEffect(() => sync(), [sync])

  if (permission !== 'default' || dismissed) return null

  const enable = async () => {
    setBusy(true)
    const result = await request()
    setBusy(false)
    // Отказ и согласие оба убирают баннер (permission перестаёт быть default).
    // Если браузер закрыл промпт без ответа, оставляем — человек может
    // передумать; но повторно не навязываем в этой сессии.
    if (result === 'default') dismiss()
  }

  return (
    <div
      role="region"
      aria-label="Уведомления"
      className="panel-surface flex shrink-0 items-center gap-3 rounded-2xl border border-border/60 px-3 py-2 backdrop-blur-xl md:px-4"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Bell className="size-4" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          Уведомления о новых сообщениях
        </p>
        <p className="hidden text-xs leading-relaxed text-muted-foreground sm:block">
          Будут приходить, даже когда вкладка свёрнута или вы в другом окне.
        </p>
      </div>

      <Button type="button" size="sm" onClick={enable} disabled={busy} className="shrink-0">
        Включить
      </Button>

      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <X className="size-4" aria-hidden="true" />
        <span className="sr-only">Не сейчас</span>
      </button>
    </div>
  )
}
