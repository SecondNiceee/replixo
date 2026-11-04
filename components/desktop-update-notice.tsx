'use client'

import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DesktopUpdateNotice() {
  const [update, setUpdate] = useState<DesktopUpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onUpdateStatus) return
    api.getUpdateStatus?.().then(setUpdate).catch(() => {})
    return api.onUpdateStatus(setUpdate)
  }, [])

  if (!update || update.status !== 'ready' || !update.version) return null
  if (dismissedVersion === update.version) return null

  const install = async () => {
    setInstalling(true)
    const started = await window.electronAPI?.installUpdate?.().catch(() => false)
    if (!started) setInstalling(false)
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] items-start gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-lg"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Download className="size-4" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{`Обновление ${update.version} готово`}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Перезапустите приложение сейчас или оно обновится при следующем закрытии.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={install} disabled={installing}>
            {installing ? 'Перезапуск…' : 'Перезапустить'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissedVersion(update.version)}>
            Позже
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDismissedVersion(update.version)}
        className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Скрыть уведомление об обновлении"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
