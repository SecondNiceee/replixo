"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { useChatButtonStore } from "@/stores/chat-button-store"
import { useAnnotationSettingsStore } from "@/stores/annotation-settings-store"
import { DEFAULT_NOISE_GATE_THRESHOLD, useRoomSettingsStore } from "@/stores/room-settings-store"
import { useRoomSettingsSync } from "@/hooks/use-room-settings-sync"
import { useMicGateMeter } from "@/hooks/use-mic-gate-meter"
import { MicGateThreshold } from "@/components/mic-gate-threshold"
import { playJoinSound, playMessageSound, playScreenShareSound } from "@/lib/sounds"
import { cn } from "@/lib/utils"

interface RoomSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: Tab
}

export type Tab = "chat" | "annotation" | "sounds" | "mic"
type CaptureTarget = "chat" | "annotation" | null

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"])

function formatHotkey(code: string | null): string {
  if (!code) return "Не назначена"
  if (code.startsWith("Key")) return code.slice(3)
  if (code.startsWith("Digit")) return code.slice(5)
  if (code.startsWith("Arrow")) return code.slice(5)
  return ({ Space: "Пробел", Enter: "Enter", Escape: "Esc", Backquote: "`", Slash: "/" } as Record<string, string>)[code] ?? code
}

// The hint describes the handle's position on the meter, not an abstract level.
function strengthHint(threshold: number): string {
  if (threshold === 0) return "Порог на нуле — гейт не закрывается."
  if (threshold <= 12) return "Режет только совсем тихий шум."
  if (threshold <= 30) return "Убирает клавиатуру и вентилятор."
  if (threshold <= 55) return "Пропускает только уверенную речь."
  if (threshold <= 80) return "Очень высоко — тихую речь обрежет."
  return "Почти на максимуме — пройдёт только крик."
}

export function RoomSettingsDialog({ open, onOpenChange, initialTab = "chat" }: RoomSettingsDialogProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [capturing, setCapturing] = useState<CaptureTarget>(null)
  const [conflict, setConflict] = useState(false)
  const chat = useChatButtonStore()
  const annotation = useAnnotationSettingsStore()
  const sounds = useRoomSettingsStore()
  useRoomSettingsSync()
  // Only measured while the Gate tab is on screen.
  const meter = useMicGateMeter(open && tab === "mic")

  useEffect(() => {
    if (open) setTab(initialTab)
    else setCapturing(null)
    setConflict(false)
  }, [initialTab, open])

  useEffect(() => {
    if (!capturing) return
    const handler = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === "Escape") return setCapturing(null)
      if (MODIFIER_CODES.has(event.code)) return
      const occupied = capturing === "annotation" ? chat.hotkey : annotation.hotkey
      if (event.code === occupied) {
        setConflict(true)
        setCapturing(null)
        return
      }
      if (capturing === "chat") chat.setHotkey(event.code)
      else annotation.setHotkey(event.code)
      setConflict(false)
      setCapturing(null)
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [annotation, capturing, chat])

  const HotkeyControl = ({ target, value }: { target: Exclude<CaptureTarget, null>; value: string | null }) => (
    <div className="flex items-center gap-2">
      {value && capturing !== target && <Button variant="ghost" size="sm" onClick={() => target === "chat" ? chat.setHotkey(null) : annotation.setHotkey(null)}>Убрать</Button>}
      <Button variant="outline" size="sm" className={cn("min-w-24", capturing === target && "border-primary text-primary")} onClick={() => { setConflict(false); setCapturing(target) }}>
        {capturing === target ? "Нажмите клавишу…" : formatHotkey(value)}
      </Button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Настройки</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
          {([['mic', 'Микрофон'], ['chat', 'Кнопка чата'], ['annotation', 'Вкл/выкл перо'], ['sounds', 'Звуки']] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setTab(value)} className={cn("min-w-24 flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors", tab === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>
          ))}
        </div>

        {tab === "mic" && <div className="flex flex-col gap-5 py-1">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Шумоподавление (Gate)</span>
              <span className="text-xs text-muted-foreground">Пока вы молчите, микрофон не передаёт звук: клавиатура, вентилятор и дыхание не долетают до комнаты.</span>
            </div>
            <button type="button" role="switch" aria-checked={sounds.noiseGate} aria-label="Шумоподавление микрофона" onClick={() => sounds.setNoiseGate(!sounds.noiseGate)} className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors", sounds.noiseGate ? "bg-primary" : "bg-muted")}>
              <span className={cn("inline-block size-5 rounded-full bg-background shadow transition-transform", sounds.noiseGate ? "translate-x-5" : "translate-x-0.5")} />
            </button>
          </div>

          <div className={cn("flex flex-col gap-2 transition-opacity", !sounds.noiseGate && "pointer-events-none opacity-50")}>
            <MicGateThreshold
              value={sounds.noiseGateStrength}
              onChange={sounds.setNoiseGateStrength}
              level={meter.level}
              open={meter.open}
              live={meter.live}
              disabled={!sounds.noiseGate}
            />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {!meter.live
                ? "Включите микрофон, чтобы увидеть уровень и проверить настройку."
                : !sounds.noiseGate
                  ? "Шумоподавление выключено — передаётся всё."
                  : meter.open
                    ? `Гейт открыт — вас слышно. ${strengthHint(sounds.noiseGateStrength)}`
                    : `Гейт закрыт — звук не передаётся. ${strengthHint(sounds.noiseGateStrength)}`}
            </p>
          </div>
        </div>}

        {tab === "chat" && <div className="flex flex-col gap-4 py-1">
          <div className="flex items-center justify-between gap-4"><div className="flex flex-col"><span className="text-sm font-medium">Показывать кнопку</span><span className="text-xs text-muted-foreground">Скрытую кнопку можно вернуть горячей клавишей.</span></div><button type="button" role="switch" aria-checked={chat.visible} aria-label="Показывать кнопку чата" onClick={() => chat.setVisible(!chat.visible)} className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors", chat.visible ? "bg-primary" : "bg-muted")}><span className={cn("inline-block size-5 rounded-full bg-background shadow transition-transform", chat.visible ? "translate-x-5" : "translate-x-0.5")} /></button></div>
          <div className="flex items-center justify-between gap-4"><div className="flex flex-col"><span className="text-sm font-medium">Горячая клавиша</span><span className="text-xs text-muted-foreground">Открывает и закрывает чат.</span></div><HotkeyControl target="chat" value={chat.hotkey} /></div>
          {conflict && <p className="text-sm text-destructive" role="alert">Эта кнопка уже занята</p>}
        </div>}

        {tab === "annotation" && <div className="flex flex-col gap-5 py-1">
          <div className="flex flex-col gap-2"><span className="text-sm font-medium">Способ включения</span><div className="flex flex-wrap gap-2"><Button variant={annotation.activation === "none" ? "default" : "outline"} size="sm" onClick={() => annotation.setActivation("none")}>Не назначено</Button><Button variant={annotation.activation === "double-click" ? "default" : "outline"} size="sm" onClick={() => annotation.setActivation("double-click")}>Двойное нажатие</Button><Button variant={annotation.activation === "hotkey" ? "default" : "outline"} size="sm" onClick={() => annotation.setActivation("hotkey")}>Клавиша</Button></div><span className="text-xs text-muted-foreground">Включает или выключает перо во время демонстрации экрана.</span></div>
          {annotation.activation === "hotkey" && <div className="flex items-center justify-between gap-4"><div className="flex flex-col"><span className="text-sm font-medium">Клавиша пера</span><span className="text-xs text-muted-foreground">Не должна совпадать с клавишей чата.</span></div><HotkeyControl target="annotation" value={annotation.hotkey} /></div>}
          {conflict && <p className="text-sm text-destructive" role="alert">Эта кнопка уже занята</p>}
        </div>}

        {tab === "sounds" && <div className="flex flex-col gap-5 py-1"><div className="flex flex-col gap-3"><div className="flex items-center justify-between"><div className="flex flex-col"><span className="text-sm font-medium">Громкость звуков</span><span className="text-xs text-muted-foreground">Уведомления приложения.</span></div><span className="text-sm font-medium tabular-nums">{sounds.soundVolume}%</span></div><Slider min={0} max={100} step={1} value={sounds.soundVolume} onValueChange={(value) => sounds.setSoundVolume(value as number)} aria-label="Громкость звуков приложения" /></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={playJoinSound}>Вход в комнату</Button><Button variant="outline" size="sm" onClick={playMessageSound}>Сообщение</Button><Button variant="outline" size="sm" onClick={playScreenShareSound}>Демонстрация экрана</Button></div></div>}

        <div className="-mx-4 -mb-4 flex justify-between gap-2 rounded-b-xl border-t bg-muted/50 p-4"><Button variant="ghost" size="sm" onClick={() => {
          if (tab === "chat") return chat.reset()
          if (tab === "annotation") return annotation.reset()
          if (tab === "mic") {
            // Only the gate — resetting the whole store here would also throw
            // away the user's sound volume, which lives on another tab.
            sounds.setNoiseGate(true)
            sounds.setNoiseGateStrength(DEFAULT_NOISE_GATE_THRESHOLD)
            return
          }
          sounds.reset()
        }}>Сбросить по умолчанию</Button><Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Готово</Button></div>
      </DialogContent>
    </Dialog>
  )
}
