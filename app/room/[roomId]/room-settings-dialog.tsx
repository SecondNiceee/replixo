"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { useChatButtonStore } from "@/stores/chat-button-store"
import { useRoomSettingsStore } from "@/stores/room-settings-store"
import { useRoomSettingsSync } from "@/hooks/use-room-settings-sync"
import {
  playJoinSound,
  playMessageSound,
  playScreenShareSound,
} from "@/lib/sounds"
import { cn } from "@/lib/utils"

interface RoomSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Tab = "chat" | "sounds"

// Modifier codes to ignore when capturing a hotkey binding.
const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight",
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight",
])

function formatHotkey(code: string | null): string {
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

export function RoomSettingsDialog({ open, onOpenChange }: RoomSettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("chat")

  // Chat button settings
  const { visible, hotkey, setVisible, setHotkey, reset: resetChat } = useChatButtonStore()
  const [capturing, setCapturing] = useState(false)

  // Sound settings
  const { soundVolume, setSoundVolume, reset: resetSounds } = useRoomSettingsStore()
  // Keep sync running for sounds
  useRoomSettingsSync()

  // Capture hotkey
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
          <DialogTitle>Настройки</DialogTitle>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setTab("chat")}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "chat"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Кнопка чата
          </button>
          <button
            type="button"
            onClick={() => setTab("sounds")}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "sounds"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Звуки
          </button>
        </div>

        {/* --- Chat button tab --- */}
        {tab === "chat" && (
          <div className="flex flex-col gap-4 py-1">
            {/* Visibility toggle */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-foreground">Показывать кнопку</span>
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
                <span className="text-sm font-medium text-foreground">Горячая клавиша</span>
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
        )}

        {/* --- Sounds tab --- */}
        {tab === "sounds" && (
          <div className="flex flex-col gap-5 py-1">
            {/* Volume slider */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    Громкость звуков
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Уведомления о входе, сообщениях и демонстрации экрана.
                  </span>
                </div>
                <span className="min-w-[2.5rem] text-right text-sm font-medium tabular-nums text-foreground">
                  {soundVolume}%
                </span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={soundVolume}
                onValueChange={(v) => setSoundVolume(v as number)}
                aria-label="Громкость звуков приложения"
              />
            </div>

            {/* Preview buttons */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Прослушать:</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={playJoinSound}
                >
                  Вход в комнату
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={playMessageSound}
                >
                  Сообщение
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={playScreenShareSound}
                >
                  Демонстрация экрана
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="-mx-4 -mb-4 flex justify-between gap-2 rounded-b-xl border-t bg-muted/50 p-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (tab === "chat") resetChat()
              else resetSounds()
            }}
          >
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
