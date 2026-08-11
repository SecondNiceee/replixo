'use client'

import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { Phone, PhoneOff } from 'lucide-react'
import { useCallStore } from '@/stores/call-store'
import { useCallActions } from '@/hooks/dm/use-calls'

// ---------------------------------------------------------------------------
// Экраны звонка: входящий вызов (во весь экран) и «звоним…» (компактная карточка).
//
// Рендерятся внутри DmNotifier, то есть на любой странице: вызов должен догнать
// пользователя и на лендинге, и в профиле. Позиция карточки исходящего звонка —
// левый нижний угол, потому что правый занят стопкой тостов.
// ---------------------------------------------------------------------------

/** Первая буква имени: аватаров у пользователей пока нет. */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function IncomingCall({ socket }: { socket: Socket | null }) {
  const incoming = useCallStore((s) => s.incoming)
  const { accept, decline } = useCallActions(socket)

  // Esc — отклонить. Привычный жест закрытия: раз экран перекрывает всё
  // приложение, из него должен быть выход с клавиатуры.
  useEffect(() => {
    if (!incoming) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') decline()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [incoming, decline])

  if (!incoming) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Входящий звонок от ${incoming.fromName}`}
      className="fixed inset-0 z-200 flex items-center justify-center bg-background/80 p-6 backdrop-blur-md"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-8 rounded-3xl border border-border/60 bg-card p-8 shadow-2xl">
        <div className="relative flex size-24 items-center justify-center">
          {/* Пульсация — единственный «декор» на экране, и он несёт смысл:
              показывает, что вызов идёт прямо сейчас, а не завис. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-ping rounded-full bg-primary/25"
          />
          <span className="relative flex size-24 items-center justify-center rounded-full bg-gradient-to-br from-primary/85 to-primary/60 text-3xl font-semibold text-primary-foreground">
            {initial(incoming.fromName)}
          </span>
        </div>

        <div className="flex flex-col items-center gap-1.5 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Входящий звонок
          </p>
          <p className="max-w-full truncate text-xl font-semibold text-foreground">
            {incoming.fromName}
          </p>
        </div>

        <div className="flex items-center gap-10">
          <button
            type="button"
            onClick={decline}
            aria-label="Отклонить звонок"
            className="flex size-16 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive active:scale-95"
          >
            <PhoneOff className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={accept}
            aria-label="Принять звонок"
            className="flex size-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 active:scale-95"
          >
            <Phone className="size-6" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

function OutgoingCall({ socket }: { socket: Socket | null }) {
  const outgoing = useCallStore((s) => s.outgoing)
  const { cancel } = useCallActions(socket)

  if (!outgoing) return null

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-100 flex w-[min(20rem,calc(100vw-2rem))] items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-lg"
    >
      <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium text-secondary-foreground">
        {initial(outgoing.toName)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-card-foreground">{outgoing.toName}</p>
        <p className="text-xs text-muted-foreground">Звоним…</p>
      </div>
      <button
        type="button"
        onClick={cancel}
        aria-label="Отменить звонок"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-transform hover:scale-105 active:scale-95"
      >
        <PhoneOff className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

export function CallOverlays({ socket }: { socket: Socket | null }) {
  return (
    <>
      <IncomingCall socket={socket} />
      <OutgoingCall socket={socket} />
    </>
  )
}
