"use client"

import { useState, useCallback } from "react"
import { Copy, Check, Video } from "lucide-react"
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

interface StartCallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: (roomCode: string) => void
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-"
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

export function StartCallDialog({ open, onOpenChange, onStart }: StartCallDialogProps) {
  const [roomCode] = useState(() => generateRoomCode())
  const [copied, setCopied] = useState(false)
  const [name, setName] = useState(() => {
    const n = getDisplayName()
    return n === DEFAULT_NAME ? "" : n
  })

  function handleStart() {
    if (name.trim().length === 0) return
    setDisplayName(name)
    onStart(roomCode)
  }

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(roomCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
      const el = document.createElement("textarea")
      el.value = roomCode
      document.body.appendChild(el)
      el.select()
      document.execCommand("copy")
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [roomCode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новая конференция</DialogTitle>
          <DialogDescription>
            Поделитесь кодом с участниками, чтобы они могли присоединиться.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-2">
          {/* Name */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Ваше имя
            </p>
            <Input
              placeholder="Введите имя"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              aria-label="Ваше имя"
              className="h-12 rounded-xl text-base"
            />
          </div>

          {/* Room code block */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Код комнаты
            </p>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3">
              <span className="flex-1 font-mono text-2xl font-semibold tracking-[0.2em] text-foreground">
                {roomCode}
              </span>
              <button
                onClick={handleCopy}
                aria-label={copied ? "Скопировано" : "Скопировать код"}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {copied ? (
                  <>
                    <Check className="size-4 text-green-500" aria-hidden="true" />
                    <span className="text-green-500">Скопировано</span>
                  </>
                ) : (
                  <>
                    <Copy className="size-4" aria-hidden="true" />
                    <span>Скопировать</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Start button */}
          <Button
            size="lg"
            className="h-12 gap-2 rounded-full text-base font-semibold"
            onClick={handleStart}
            disabled={name.trim().length === 0}
          >
            <Video className="size-5" aria-hidden="true" />
            Начать конференцию
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
