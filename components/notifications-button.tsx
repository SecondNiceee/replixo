'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Check, UserCheck, UserPlus, UserX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useNotifications,
  type AppNotificationKind,
  type StoredNotification,
} from '@/hooks/dm/use-notifications'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Центр уведомлений в шапке: колокольчик с бейджем + панель со списком.
//
// Зачем он нужен помимо тостов: тост живёт секунды и только при живом
// websocket. Пользователь, который был офлайн или перезагрузил страницу,
// «вашу заявку приняли» раньше не узнавал вообще. Здесь список читается из БД,
// поэтому событие ждёт его столько, сколько нужно.
//
// Свой popover, а не DropdownMenu: у меню роль `menu`, оно перехватывает
// стрелки и закрывается на любой клик по элементу — а здесь внутри строк живут
// собственные кнопки («прочитано», «удалить») и клик по ним панель закрывать
// не должен.
// ---------------------------------------------------------------------------

const ICONS: Record<AppNotificationKind, typeof UserPlus> = {
  'friend-request': UserPlus,
  'friend-accepted': UserCheck,
  'friend-declined': UserX,
}

/** Текст уведомления. Единственное место, где вид превращается во фразу. */
function describe(kind: AppNotificationKind): string {
  if (kind === 'friend-request') return 'хочет добавить вас в друзья'
  if (kind === 'friend-accepted') return 'принял вашу заявку в друзья'
  return 'отклонил вашу заявку в друзья'
}

/** Куда ведёт клик. Отказ никуда не ведёт: делать по нему нечего. */
function linkFor(n: StoredNotification): string | null {
  if (n.kind === 'friend-request') return '/profile'
  if (n.kind === 'friend-accepted') return `/chat?u=${encodeURIComponent(n.actorId)}`
  return null
}

/** Относительное время: точная дата в уведомлении не нужна, свежесть — да. */
function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ч`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} дн`
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function NotificationRow({
  item,
  onNavigate,
  onMarkRead,
  onRemove,
}: {
  item: StoredNotification
  onNavigate: (href: string, id: string) => void
  onMarkRead: (id: string) => void
  onRemove: (id: string) => void
}) {
  const Icon = ICONS[item.kind]
  const href = linkFor(item)

  return (
    <li
      className={cn(
        'group relative flex items-start gap-3 rounded-lg p-2.5 transition-colors',
        item.read ? 'hover:bg-secondary/50' : 'bg-secondary/40 hover:bg-secondary/70',
      )}
    >
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
        {item.actorName.trim().charAt(0).toUpperCase() || '?'}
      </div>

      <div className="min-w-0 flex-1">
        {/* Весь блок — одна кнопка: попадать нужно по строке, а не по слову. */}
        <button
          type="button"
          onClick={() => (href ? onNavigate(href, item.id) : onMarkRead(item.id))}
          className="block w-full text-left"
        >
          <div className="flex items-center gap-1.5">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-medium text-foreground">
              {item.actorName}
            </span>
            {!item.read && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                aria-label="Не прочитано"
              />
            )}
          </div>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            {describe(item.kind)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground/70">{timeAgo(item.createdAt)}</p>
        </button>
      </div>

      {/* Действия строки. На мобильных hover нет, поэтому не скрываем их
          полностью, а лишь приглушаем — иначе удалить было бы невозможно. */}
      <div className="flex shrink-0 flex-col gap-1 opacity-60 transition-opacity group-hover:opacity-100">
        {!item.read && (
          <button
            type="button"
            onClick={() => onMarkRead(item.id)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Check className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Отметить прочитанным</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Удалить уведомление</span>
        </button>
      </div>
    </li>
  )
}

export function NotificationsButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const { items, unread, isLoading, markRead, remove } = useNotifications()
  const wrapRef = useRef<HTMLDivElement>(null)

  // Клик вне панели и Escape закрывают её. Слушатели навешиваем только когда
  // панель открыта: иначе они висели бы на документе всё время работы шапки.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const go = (href: string, id: string) => {
    // Отметку не ждём: переход важнее, а бейдж уже погашен оптимистично.
    void markRead(id)
    setOpen(false)
    router.push(href)
  }

  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Уведомления, ${unread} непрочитанных` : 'Уведомления'}
        className="relative text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <Bell className="size-4" aria-hidden="true" />
        {unread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
            aria-hidden="true"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Уведомления"
          className="absolute right-0 top-full z-50 mt-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-1.5 pb-2">
            <p className="text-sm font-medium">Уведомления</p>
            {items.length > 0 && (
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button
                    type="button"
                    onClick={() => void markRead()}
                    className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    Прочитать все
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  Очистить
                </button>
              </div>
            )}
          </div>

          {/* Список ограничен по высоте: 30 уведомлений не должны уезжать
              за пределы экрана. */}
          {isLoading && items.length === 0 ? (
            <p className="px-1.5 py-6 text-center text-sm text-muted-foreground">Загрузка…</p>
          ) : items.length === 0 ? (
            <p className="px-1.5 py-6 text-center text-sm text-muted-foreground">
              Пока ничего нет
            </p>
          ) : (
            <ul className="flex max-h-[min(24rem,60vh)] flex-col gap-1 overflow-y-auto">
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  onNavigate={go}
                  onMarkRead={(id) => void markRead(id)}
                  onRemove={(id) => void remove(id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
