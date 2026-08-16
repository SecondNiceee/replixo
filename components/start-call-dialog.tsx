"use client"

import { useState, useCallback } from "react"
import { Copy, Check, Video, LogIn } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { copyText } from "@/lib/clipboard"
import { normalizeRoomCode } from "@/lib/room-code"
import { cn } from "@/lib/utils"

interface StartCallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: (roomCode: string) => void
  /**
   * Вход в чужую комнату по коду. Передаётся не всегда: на лендинге для этого
   * есть отдельная кнопка «Войти по коду» рядом с «Начать звонок», и второй путь
   * в том же диалоге был бы дублем. В кабинете кнопка одна, поэтому вход по коду
   * живёт внутри — без него присоединиться к звонку из кабинета было нельзя.
   */
  onJoin?: (roomCode: string) => void
  /**
   * Классы для содержимого диалога. Нужны кабинету: DialogContent уходит в
   * портал у <body>, вне <main class="app-dark">, и без явного класса берёт
   * палитру :root — то есть без синего акцента кабинета.
   */
  contentClassName?: string
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

export function StartCallDialog({
  open,
  onOpenChange,
  onStart,
  onJoin,
  contentClassName,
}: StartCallDialogProps) {
  const [roomCode] = useState(() => generateRoomCode())
  const [copied, setCopied] = useState(false)
  // Код чужой комнаты. Держим отдельно от roomCode: тот — свой, сгенерированный,
  // и перетирать его вводом нельзя, иначе «Начать конференцию» после набора
  // увело бы в комнату собеседника.
  const [joinValue, setJoinValue] = useState("")
  const [joinError, setJoinError] = useState("")

  const joinClean = normalizeRoomCode(joinValue)
  // 4 символа + дефис + 4 символа.
  const canJoin = joinClean.length === 9

  function handleStart() {
    onStart(roomCode)
  }

  function handleJoinChange(e: React.ChangeEvent<HTMLInputElement>) {
    setJoinError("")
    setJoinValue(normalizeRoomCode(e.target.value))
  }

  function handleJoin() {
    if (!canJoin) {
      setJoinError("Введите корректный код комнаты (8 символов).")
      return
    }
    onJoin?.(joinClean)
  }

  function handleJoinKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Enter в поле кода — вход в комнату, но не отправка формы диалога.
    // isComposing/229 — набор через IME: там Enter подтверждает символ.
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleJoin()
  }

  const handleCopy = useCallback(async () => {
    const ok = await copyText(roomCode)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [roomCode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', contentClassName)}>
        <DialogHeader>
          <DialogTitle>Новая конференция</DialogTitle>
          <DialogDescription>
            {onJoin
              ? 'Поделитесь кодом с участниками — или войдите в чужую комнату по коду.'
              : 'Поделитесь кодом с участниками, чтобы они могли присоединиться.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-2">
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
          >
            <Video className="size-5" aria-hidden="true" />
            Начать конференцию
          </Button>

          {/* Вход по коду — второй, отдельный сценарий того же диалога, поэтому
              отделён линией с подписью «или»: без разделителя два поля с кодом
              подряд читались бы как один шаг, и код комнаты выше можно было
              принять за то, что нужно заменить своим. */}
          {onJoin && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  или
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Войти по коду
                </p>
                <Input
                  placeholder="XXXX-XXXX"
                  value={joinValue}
                  onChange={handleJoinChange}
                  onKeyDown={handleJoinKeyDown}
                  aria-label="Код комнаты для входа"
                  aria-invalid={!!joinError}
                  className="h-12 rounded-xl text-center font-mono text-xl tracking-[0.2em] placeholder:tracking-normal"
                />
                {joinError && (
                  <p className="text-xs text-destructive" role="alert">
                    {joinError}
                  </p>
                )}
              </div>

              {/* Не primary: главное действие диалога — «Начать конференцию»,
                  и две сплошные кнопки подряд не давали бы понять, какая из них
                  основная. */}
              <Button
                variant="secondary"
                size="lg"
                className="h-12 gap-2 rounded-full text-base font-semibold"
                onClick={handleJoin}
                disabled={!canJoin}
              >
                <LogIn className="size-5" aria-hidden="true" />
                Войти в комнату
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
