"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useChatButtonStore } from "@/stores/chat-button-store"
import { cn } from "@/lib/utils"

interface ChatButtonSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Modifier codes we ignore when capturing a binding — a hotkey on its own
// modifier makes no sense.
const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight",
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight",
])

/** Human-readable label for a KeyboardEvent.code. */
export function formatHotkey(code: string | null): string {
  if (!code) return "Не назначена"
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  if (code.startsWith("Arrow")) return code.slice(5)
  const map: Record<string, string> = {
    Space: "Пробел",
    Enter: "Enter",
    Escape: "Esc",
    Backquote: "`",
    Slash: "/",
  }
  return map[code] ?? code
}

export function ChatButtonSettingsDialog({
  open,
  onOpenChange,
}: ChatButtonSettingsDialogProps) {
  const { visible, hotkey, setVisible, setHotkey, reset } = useChatButtonStore()
  const [capturing, setCapturing] = useState(false)

  // While capturing, listen for the next non-modifier keypress and bind it.
  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === "Escape") {
        setCapturing(false)
        return
      }
      if (MODIFIER_CODES.has(e.code)) return
      setHotkey(e.code)
      setCapturing(false)
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [capturing, setHotkey])

  // Stop capturing if the dialog closes.
  useEffect(() => {
    if (!open) setCapturing(false)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Настройки кнопки чата</DialogTitle>
          <DialogDescription>
            Управляйте видимостью кнопки и горячей клавишей для открытия чата.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          {/* Visibility toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                Показывать кнопку
              </span>
              <span className="text-xs text-muted-foreground">
                Скрытую кнопку всегда можно вернуть горячей клавишей.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={visible}
              aria-label="Показывать кнопку чата"
              onClick={() => setVisible(!visible)}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                visible ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
                  visible ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          {/* Hotkey rebinding */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                Горячая клавиша
              </span>
              <span className="text-xs text-muted-foreground">
                Открывает и закрывает чат из любого места комнаты.
              </span>
            </div>
            <div className="flex items-center gap-2">
              {hotkey && !capturing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHotkey(null)}
                  aria-label="Сбросить горячую клавишу"
                >
                  Убрать
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCapturing(true)}
                className={cn("min-w-24", capturing && "border-primary text-primary")}
              >
                {capturing ? "Нажмите клавишу…" : formatHotkey(hotkey)}
              </Button>
            </div>
          </div>
        </div>

        <div className="-mx-4 -mb-4 flex justify-between gap-2 rounded-b-xl border-t bg-muted/50 p-4">
          <Button variant="ghost" size="sm" onClick={reset}>
            Сбросить по умолчанию
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Готово
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
