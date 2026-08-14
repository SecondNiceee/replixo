'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign, Check, Loader2, LogOut, Mail, Pencil, Settings, X } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface AccountDialogProps {
  displayName: string
  email: string
}

/**
 * Аккаунт в шапке левой панели, как в Telegram: строка с аватаром открывает
 * панель с email и сменой username.
 *
 * Раньше это была раскрытая «шапка профиля» на всю ширину страницы. В раскладке
 * со списком чатов слева и перепиской справа для неё нет места: любая
 * постоянная плашка сверху отнимает высоту у самого важного — ленты сообщений.
 */
export function AccountDialog({ displayName, email }: AccountDialogProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const handleSignOut = async () => {
    setSigningOut(true)
    await authClient.signOut()
    // refresh обязателен: без него серверный редирект с / на /profile всё ещё
    // видел бы закешированную сессию и вернул бы нас обратно в кабинет.
    router.push('/')
    router.refresh()
  }

  const startEdit = () => {
    setValue(displayName)
    setError(null)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const cancelEdit = () => {
    setEditing(false)
    setError(null)
  }

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === displayName) {
      setEditing(false)
      return
    }
    setLoading(true)
    setError(null)
    const res = await fetch('/api/user/username', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(data.error ?? 'Ошибка')
      return
    }
    // username приезжает из серверной сессии, поэтому обновляем страницу —
    // иначе он остался бы старым и в шапке, и в заявках.
    window.location.reload()
  }

  return (
    <Dialog>
      <DialogTrigger
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/5"
        aria-label="Открыть настройки"
      >
        {/* Аватар плоский, с моноширинной буквой и тонким кольцом: градиент
            остался только у логотипа, чтобы акцент в панели был один. */}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-sm font-medium text-foreground ring-1 ring-inset ring-border">
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium leading-tight text-foreground">
            {displayName}
          </span>
          <span className="truncate text-[11px] leading-tight text-muted-foreground">{email}</span>
        </span>
        {/* Шестерёнка, а не карандаш: строка открывает настройки целиком —
            и переименование, и выход, — а карандаш обещал бы только правку имени. */}
        <Settings className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DialogTrigger>

      {/* app-dark обязателен: портал у <body> лежит вне <main class="app-dark">. */}
      <DialogContent className="app-dark bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>Ваш username виден друзьям и в заявках.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-secondary/20 p-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-lg text-foreground ring-1 ring-inset ring-border">
            {displayName.charAt(0).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-base font-semibold text-foreground">{displayName}</span>
            <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <Mail className="size-3.5 shrink-0" aria-hidden="true" />
              {email}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <AtSign className="size-3.5" aria-hidden="true" />
            Username
          </span>

          {editing ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value)
                    setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  maxLength={20}
                  className="h-9 flex-1"
                  disabled={loading}
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-9 text-muted-foreground hover:text-foreground"
                  onClick={submit}
                  disabled={loading}
                  aria-label="Сохранить username"
                >
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-9 text-muted-foreground hover:text-destructive"
                  onClick={cancelEdit}
                  disabled={loading}
                  aria-label="Отменить"
                >
                  <X className="size-4" />
                </Button>
              </div>
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Только латинские буквы, цифры, _ (2–20 символов)
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
              <span className="truncate text-sm text-foreground">{displayName}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={startEdit}
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" />
                Изменить
              </Button>
            </div>
          )}
        </div>

        {/* Выход отделён линией: это единственное необратимое действие в панели,
            и его нельзя ставить вплотную к безобидной правке username. */}
        <div className="mt-1 border-t border-border/60 pt-4">
          <Button
            variant="ghost"
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="size-4" aria-hidden="true" />
            )}
            Выйти из аккаунта
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
