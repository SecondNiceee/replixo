"use client"

import { useMemo, useState } from "react"
import {
  Mic, MicOff, Video, VideoOff, PhoneOff,
  Check, ChevronDown, MonitorUp, MonitorOff,
  ChevronUp, Presentation, Pencil, Loader2, Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { ScreenQuality } from "@/hooks/use-mediasoup"
import type { AudioDevice } from "@/hooks/use-audio-devices"
import { useAudioLevel } from "@/hooks/use-speaking"

const SCREEN_QUALITY_OPTIONS: { value: ScreenQuality; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p (Full HD)" },
]

interface RoomControlsProps {
  isMicMuted: boolean
  localStream: MediaStream | null
  isCamOff: boolean
  // True while the camera is turning on — the camera button shows a loader.
  isCamStarting: boolean
  isScreenSharing: boolean
  screenQuality: ScreenQuality
  micDevices: AudioDevice[]
  activeMicId: string | null
  isMicSwitching: boolean
  collapsed: boolean
  whiteboardOpen: boolean
  onToggleWhiteboard: () => void
  // Screen-share annotation (рисование поверх стрима). Доступно только когда
  // идёт демонстрация экрана (свой или чужой).
  annotationActive: boolean
  canAnnotate: boolean
  onToggleAnnotation: () => void
  onToggleCollapsed: () => void
  onToggleMic: () => void
  onToggleCam: () => void
  onToggleScreenShare: () => void
  onSetScreenQuality: (q: ScreenQuality) => void
  onSwitchMic: (deviceId: string) => Promise<boolean>
  onLeave: () => void
}

export function RoomControls({
  isMicMuted,
  localStream,
  isCamOff,
  isCamStarting,
  isScreenSharing,
  screenQuality,
  micDevices,
  activeMicId,
  isMicSwitching,
  collapsed,
  whiteboardOpen,
  onToggleWhiteboard,
  annotationActive,
  canAnnotate,
  onToggleAnnotation,
  onToggleCollapsed,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onSetScreenQuality,
  onSwitchMic,
  onLeave,
}: RoomControlsProps) {
  const [micSettingsOpen, setMicSettingsOpen] = useState(false)
  // Recreate the meter stream after a device switch. The call stream itself is
  // mutated in place, so depending on it alone would leave the analyser attached
  // to the stopped track from the previous microphone.
  const micMeterStream = useMemo(() => {
    const track = localStream?.getAudioTracks()[0]
    return track ? new MediaStream([track]) : null
  }, [localStream, activeMicId])
  const audioLevel = useAudioLevel(micMeterStream, micSettingsOpen && !isMicMuted)
  const hasSignal = audioLevel >= 4

  return (
    <div className="relative">
      {/* Toggle handle — always visible above the footer, kept outside the
          collapsing area so it stays on screen when the panel is hidden */}
      <div className="absolute -top-7 left-1/2 -translate-x-1/2">
        <button
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Показать панель управления" : "Скрыть панель управления"}
          className="flex h-7 w-14 items-center justify-center rounded-t-xl border border-b-0 border-border bg-background/90 backdrop-blur-sm transition-colors hover:bg-accent"
        >
          <ChevronUp
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-300",
              !collapsed && "rotate-180",
            )}
          />
        </button>
      </div>

      {/* Collapsing area: animates its height to 0 via the grid-rows 1fr/0fr
          trick, so the main content above expands to fill the freed space */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-in-out",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className={cn(collapsed ? "overflow-hidden" : "overflow-visible")}>
    <footer className="flex items-center justify-center gap-3 border-t border-border px-5 py-4">
      {/* Mic + device settings */}
      <Dialog open={micSettingsOpen} onOpenChange={setMicSettingsOpen}>
        <div className="group relative flex items-center">
          <div
            className={cn(
              "pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 pb-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100",
              micSettingsOpen && "pointer-events-auto opacity-100",
            )}
          >
            <DialogTrigger
              render={(
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 rounded-full shadow-md"
                />
              )}
              disabled={isMicSwitching}
              aria-label="Настройки микрофона"
              aria-busy={isMicSwitching}
            >
              {isMicSwitching ? <Loader2 className="animate-spin" /> : <Settings />}
            </DialogTrigger>
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={onToggleMic}
            className={cn(
              "size-12 rounded-full",
              isMicMuted && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
            )}
            aria-label={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
          >
            {isMicMuted ? <MicOff /> : <Mic />}
          </Button>
        </div>

        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Настройки микрофона</DialogTitle>
            <DialogDescription>
              Выберите устройство и проверьте, насколько хорошо вас слышно.
            </DialogDescription>
          </DialogHeader>

          <section className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby="mic-test-title">
            <div className="flex items-center justify-between gap-3">
              <h3 id="mic-test-title" className="font-medium">Проверка микрофона</h3>
              <span className="text-sm text-muted-foreground" aria-live="polite">
                {isMicMuted ? "Микрофон выключен" : hasSignal ? "Звук есть" : "Звука нет"}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label="Уровень сигнала микрофона"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={audioLevel}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-75"
                style={{ width: `${audioLevel}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Скажите что-нибудь, чтобы проверить микрофон.
            </p>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="mic-device-title">
            <h3 id="mic-device-title" className="font-medium">Устройство ввода</h3>
            <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
              {micDevices.length === 0 && (
                <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  Нет доступных микрофонов
                </p>
              )}
              {micDevices.map((device) => {
                const selected = activeMicId === device.deviceId
                return (
                  <Button
                    key={device.deviceId}
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                    disabled={isMicSwitching}
                    onClick={() => void onSwitchMic(device.deviceId)}
                    className="h-auto justify-between py-3"
                    aria-pressed={selected}
                  >
                    <span className="truncate text-left">{device.label}</span>
                    {selected && <Check />}
                  </Button>
                )
              })}
            </div>
          </section>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Закрыть
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Camera */}
      <Button
        variant="outline"
        size="icon"
        onClick={onToggleCam}
        disabled={isCamStarting}
        className={cn(
          "size-12 rounded-full",
          isCamOff && !isCamStarting && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
        aria-label={isCamStarting ? "Включение камеры…" : isCamOff ? "Включить камеру" : "Выключить камеру"}
        aria-busy={isCamStarting}
      >
        {isCamStarting ? (
          <Loader2 className="size-5 animate-spin" />
        ) : isCamOff ? (
          <VideoOff className="size-5" />
        ) : (
          <Video className="size-5" />
        )}
      </Button>

      {/* Screen share + quality picker */}
      <div className="flex items-center">
        <Button
          variant="outline"
          onClick={onToggleScreenShare}
          className={cn(
            "size-12 rounded-full rounded-r-none border-r-0",
            isScreenSharing && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
          )}
          aria-label={isScreenSharing ? "Остановить демонстрацию экрана" : "Демонстрация экрана"}
        >
          {isScreenSharing ? <MonitorOff className="size-5" /> : <MonitorUp className="size-5" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex h-12 w-6 items-center justify-center rounded-l-none rounded-r-full border border-input bg-background px-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none",
              isScreenSharing && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
            )}
            aria-label="Качество демонстрации экрана"
          >
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Качество экрана</DropdownMenuLabel>
              {SCREEN_QUALITY_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => onSetScreenQuality(opt.value)}
                  className="flex items-center justify-between gap-4"
                >
                  <span className={cn(screenQuality === opt.value && "font-medium")}>{opt.label}</span>
                  {screenQuality === opt.value && <Check className="size-3.5 text-foreground" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Annotation — рисование поверх демонстрации экрана. Показывается только
          когда идёт демонстрация (своя или чужая). */}
      {canAnnotate && (
        <Button
          variant="outline"
          size="icon"
          onClick={onToggleAnnotation}
          className={cn(
            "size-12 rounded-full",
            annotationActive && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
          )}
          aria-label={annotationActive ? "Закрыть рисование по экрану" : "Рисовать по экрану"}
        >
          <Pencil className="size-5" />
        </Button>
      )}

      {/* Whiteboard — follows annotation so the two drawing tools are easy to compare. */}
      <Button
        variant="outline"
        size="icon"
        onClick={onToggleWhiteboard}
        className={cn(
          "size-12 rounded-full",
          whiteboardOpen && "border-foreground bg-foreground/10 text-foreground hover:bg-foreground/20",
        )}
        aria-label={whiteboardOpen ? "Закрыть доску" : "Открыть совместную доску"}
      >
        <Presentation className="size-5" />
      </Button>

      {/* Chat now lives in a draggable floating button (FloatingChatButton),
          so it's no longer part of the footer cluster. */}

      {/* Leave */}
      <Button
        variant="destructive"
        size="icon"
        onClick={onLeave}
        className="size-12 rounded-full"
        aria-label="Покинуть комнату"
      >
        <PhoneOff className="size-5" />
      </Button>
    </footer>
        </div>
      </div>
    </div>
  )
}
