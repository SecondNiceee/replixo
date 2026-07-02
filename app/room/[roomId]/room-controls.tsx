"use client"

import {
  Mic, MicOff, Video, VideoOff, PhoneOff,
  Check, ChevronDown, MonitorUp, MonitorOff,
  ChevronUp, SquarePen, Pencil,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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

const SCREEN_QUALITY_OPTIONS: { value: ScreenQuality; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p (Full HD)" },
]

interface RoomControlsProps {
  isMicMuted: boolean
  isCamOff: boolean
  isScreenSharing: boolean
  screenQuality: ScreenQuality
  micDevices: AudioDevice[]
  selectedMicLabel: string | null
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
  onSwitchMic: (deviceId: string) => void
  onSelectMicLabel: (label: string) => void
  onLeave: () => void
}

export function RoomControls({
  isMicMuted,
  isCamOff,
  isScreenSharing,
  screenQuality,
  micDevices,
  selectedMicLabel,
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
  onSelectMicLabel,
  onLeave,
}: RoomControlsProps) {
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
        <div className="overflow-hidden">
    <footer className="flex items-center justify-center gap-3 border-t border-border px-5 py-4">
      {/* Mic + device picker */}
      <div className="flex items-center">
        <Button
          variant="outline"
          onClick={onToggleMic}
          className={cn(
            "size-12 rounded-full rounded-r-none border-r-0",
            isMicMuted && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
          )}
          aria-label={isMicMuted ? "Включить микрофон" : "Выключить микрофон"}
        >
          {isMicMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex h-12 w-6 items-center justify-center rounded-l-none rounded-r-full border border-input bg-background px-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none",
              isMicMuted && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
            )}
            aria-label="Выбрать микрофон"
          >
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" side="top">
            {micDevices.length === 0 && (
              <DropdownMenuItem disabled>Нет доступных микрофонов</DropdownMenuItem>
            )}
            {micDevices.map((d) => (
              <DropdownMenuItem
                key={d.deviceId}
                onSelect={async () => {
                  onSelectMicLabel(d.label)
                  await onSwitchMic(d.deviceId)
                }}
                className={cn(selectedMicLabel === d.label && "font-medium")}
              >
                {d.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Camera */}
      <Button
        variant="outline"
        size="icon"
        onClick={onToggleCam}
        className={cn(
          "size-12 rounded-full",
          isCamOff && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
        aria-label={isCamOff ? "Включить камеру" : "Выключить камеру"}
      >
        {isCamOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
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
                  onSelect={() => onSetScreenQuality(opt.value)}
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

      {/* Whiteboard */}
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
          <SquarePen className="size-5" />
      </Button>

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
