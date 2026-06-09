"use client"

import { useState } from "react"
import { LogIn } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getDisplayName, setDisplayName, DEFAULT_NAME } from "@/lib/display-name"

interface JoinCallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onJoin: (roomCode: string) => void
}

function normalizeCode(raw: string): string {
  // strip everything except letters, digits, dash — then ensure format XXXX-XXXX
  const letters = raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (letters.length <= 4) return letters
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

export function JoinCallDialog({ open, onOpenChange, onJoin }: JoinCallDialogProps) {
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const [name, setName] = useState(() => {
    const n = getDisplayName()
    return n === DEFAULT_NAME ? "" : n
  })

  const clean = normalizeCode(value)
  // valid when we have 4 letters + dash + 4 letters = 9 chars
  const isValid = clean.length === 9 && name.trim().length > 0

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError("")
    const raw = e.target.value
    // keep only letters and digits, max 8 chars, then auto-format as XXXX-XXXX
    const letters = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
    if (letters.length <= 4) {
      setValue(letters)
    } else {
      setValue(`${letters.slice(0, 4)}-${letters.slice(4)}`)
    }
  }

  function handleJoin() {
    if (clean.length !== 9) {
      setError("Введите корректный код комнаты (8 символов).")
      return
    }
    if (name.trim().length === 0) {
      setError("Введите ваше имя.")
      return
    }
    setDisplayName(name)
    onJoin(clean)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleJoin()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setValue(""); setError("") } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Войти по коду</DialogTitle>
          <DialogDescription>
            Введите код комнаты, который прислал организатор.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Ваше имя"
              value={name}
              onChange={(e) => { setError(""); setName(e.target.value) }}
              maxLength={32}
              aria-label="Ваше имя"
              className="h-12 rounded-xl text-base"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Input
              placeholder="XXXX-XXXX"
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              autoFocus
              aria-label="Код комнаты"
              aria-invalid={!!error}
              className="h-12 rounded-xl text-center font-mono text-xl tracking-[0.2em] placeholder:tracking-normal"
            />
            {error && (
              <p className="text-xs text-red-500" role="alert">
                {error}
              </p>
            )}
          </div>

          <Button
            size="lg"
            className="h-12 gap-2 rounded-full text-base font-semibold"
            onClick={handleJoin}
            disabled={!isValid}
          >
            <LogIn className="size-5" aria-hidden="true" />
            Войти в комнату
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
