'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle, UserCheck, UserPlus, UserX, X } from 'lucide-react'
import {
  useNotificationsStore,
  type AppNotification,
  type NotificationKind,
} from '@/stores/notifications-store'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Стопка всплывающих уведомлений. Рендерится один раз на приложение (внутри
// DmNotifier), поэтому видна на любой странице — в профиле, в чате, внутри звонка.
//
// Позиция — правый нижний угол: сверху в Electron-сборке живёт кастомный
// титлбар, а у страниц есть свои шапки, и тост бы их перекрывал.
// ---------------------------------------------------------------------------

const ICONS: Record<NotificationKind, typeof UserPlus> = {
  'friend-request': UserPlus,
  'friend-accepted': UserCheck,
  'friend-declined': UserX,
  message: MessageCircle,
}

/** Первая буква имени для «аватара»-заглушки. */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function Toast({ item }: { item: AppNotification }) {
  const router = useRouter()
  const dismiss = useNotificationsStore((s) => s.dismiss)
  const Icon = ICONS[item.kind]

  // Появление анимируем после монтирования: если поставить конечные классы
  // сразу, браузеру нечего интерполировать и переход не сыграет.
  const [shown, setShown] = useState(false)
  const [paused, setPaused] = useState(false)

  // dismiss из zustand стабилен между рендерами, но держим в ref, чтобы эффект
  // автоскрытия зависел только от паузы и не перезапускал таймер зря.
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Автоскрытие. На hover таймер снимается: пользователь читает или тянется к
  // кнопке действия, и уводить тост из-под курсора нельзя.
  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => dismissRef.current(item.id), item.duration)
    return () => clearTimeout(timer)
  }, [item.id, item.duration, paused])

  const go = () => {
    if (!item.href) return
    dismiss(item.id)
    router.push(item.href)
  }

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-lg',
        'transition-all duration-200 ease-out',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-secondary-foreground">
        {initial(item.title)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="truncate text-sm font-medium text-card-foreground">{item.title}</p>
        </div>

        {item.body && (
          // line-clamp-2: длинное сообщение не должно растягивать тост на пол-экрана.
          <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {item.body}
          </p>
        )}

        {item.href && item.actionLabel && (
          <button
            type="button"
            onClick={go}
            className="mt-2 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent"
          >
            {item.actionLabel}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => dismiss(item.id)}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Закрыть уведомление</span>
      </button>
    </div>
  )
}

export function AppToasts() {
  const items = useNotificationsStore((s) => s.items)

  // Контейнер держим в дереве всегда: aria-live работает только если регион
  // существовал до появления содержимого, иначе скринридер молча его пропустит.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-4 z-100 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  )
}
