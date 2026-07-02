'use client'

import { useState, useRef } from 'react'
import { Check, X, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ProfileHeaderProps {
  displayName: string
  email: string
}

export function ProfileHeader({ displayName, email }: ProfileHeaderProps) {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameLoading, setNameLoading] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const startEditName = () => {
    setNameValue(displayName)
    setNameError(null)
    setEditingName(true)
    setTimeout(() => nameInputRef.current?.select(), 0)
  }

  const cancelEditName = () => {
    setEditingName(false)
    setNameError(null)
  }

  const submitEditName = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed || trimmed === displayName) {
      setEditingName(false)
      return
    }
    setNameLoading(true)
    setNameError(null)
    const res = await fetch('/api/user/username', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
    })
    const data = await res.json()
    setNameLoading(false)
    if (!res.ok) {
      setNameError(data.error ?? 'Ошибка')
      return
    }
    window.location.reload()
  }

  return (
    <div className="flex items-start gap-4">
      <div className="mt-1 flex size-14 shrink-0 items-center justify-center rounded-full bg-secondary text-xl font-semibold text-foreground">
        {displayName.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0">
        {editingName ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                ref={nameInputRef}
                value={nameValue}
                onChange={(e) => {
                  setNameValue(e.target.value)
                  setNameError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitEditName()
                  if (e.key === 'Escape') cancelEditName()
                }}
                maxLength={20}
                className="h-8 w-48 text-base font-semibold"
                disabled={nameLoading}
                autoFocus
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={submitEditName}
                disabled={nameLoading}
                aria-label="Сохранить имя"
              >
                {nameLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={cancelEditName}
                disabled={nameLoading}
                aria-label="Отменить"
              >
                <X className="size-4" />
              </Button>
            </div>
            {nameError && (
              <p className="text-xs text-destructive" role="alert">
                {nameError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Только латинские буквы, цифры, _ (2–20 символов)
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{displayName}</h1>
            <button
              onClick={startEditName}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Изменить username"
            >
              <Pencil className="size-4" />
            </button>
          </div>
        )}
        <p className="text-sm text-muted-foreground">{email}</p>
      </div>
    </div>
  )
}
