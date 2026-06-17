"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { MessageSquare, Settings, Hand } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/lib/stores/chat-settings-store"

interface ChatFabProps {
  open: boolean
  unreadCount: number
  onToggleChat: () => void
}

// Размер кнопки и отступ по умолчанию от краёв окна.
const FAB_SIZE = 56
const DEFAULT_MARGIN = 24
const DRAG_THRESHOLD = 4 // px — ниже этого считаем нажатие кликом, а не перетаскиванием

// Человекочитаемые подписи для распространённых клавиш.
function keyLabel(key: string): string {
  if (key === " ") return "Пробел"
  if (key === "Tab") return "Tab"
  if (key === "Enter") return "Enter"
  if (key === "Escape") return "Esc"
  if (key.length === 1) return key.toUpperCase()
  return key
}

export function ChatFab({ open, unreadCount, onToggleChat }: ChatFabProps) {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const [hovered, setHovered] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [capturingKey, setCapturingKey] = useState(false)

  // Текущее положение кнопки в пикселях (левый-верхний угол). Вычисляется из
  // сохранённых долей или дефолтного правого-нижнего угла.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  // Состояние текущего перетаскивания.
  const dragState = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)

  // Перевести сохранённые доли (от правого-нижнего угла) в координаты пикселей.
  const computePos = useCallback(() => {
    if (typeof window === "undefined") return { x: 0, y: 0 }
    const maxX = window.innerWidth - FAB_SIZE
    const maxY = window.innerHeight - FAB_SIZE
    if (settings.buttonX == null || settings.buttonY == null) {
      return { x: maxX - DEFAULT_MARGIN, y: maxY - DEFAULT_MARGIN }
    }
    // buttonX/Y — доля расстояния от правого/нижнего края.
    const x = maxX - settings.buttonX * maxX
    const y = maxY - settings.buttonY * maxY
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    }
  }, [settings.buttonX, settings.buttonY])

  // Инициализация и пересчёт при ресайзе / смене сохранённой позиции.
  useEffect(() => {
    setPos(computePos())
    const onResize = () => setPos(computePos())
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [computePos])

  // Перетаскивание через Pointer Events.
  const onPointerMove = useCallback((e: PointerEvent) => {
    const st = dragState.current
    if (!st) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    if (!st.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    st.moved = true
    setDragging(true)
    const maxX = window.innerWidth - FAB_SIZE
    const maxY = window.innerHeight - FAB_SIZE
    const x = Math.min(Math.max(0, st.originX + dx), maxX)
    const y = Math.min(Math.max(0, st.originY + dy), maxY)
    setPos({ x, y })
  }, [])

  const onPointerUp = useCallback(() => {
    const st = dragState.current
    dragState.current = null
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)

    if (st?.moved) {
      // Сохранить позицию как доли от правого-нижнего угла.
      const maxX = window.innerWidth - FAB_SIZE
      const maxY = window.innerHeight - FAB_SIZE
      setPos((p) => {
        if (p) {
          update({
            buttonX: maxX > 0 ? (maxX - p.x) / maxX : 0,
            buttonY: maxY > 0 ? (maxY - p.y) / maxY : 0,
          })
        }
        return p
      })
      // Сбросить флаг чуть позже, чтобы click по кнопке не сработал.
      setTimeout(() => setDragging(false), 0)
    } else {
      setDragging(false)
    }
  }, [onPointerMove, update])

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      if (!pos) return
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false,
      }
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", onPointerUp)
    },
    [pos, onPointerMove, onPointerUp],
  )

  // Захват новой горячей клавиши.
  useEffect(() => {
    if (!capturingKey) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === "Escape") {
        setCapturingKey(false)
        return
      }
      update({ openChatKey: e.key })
      setCapturingKey(false)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [capturingKey, update])

  // Закрыть попап настроек по клику вне его.
  useEffect(() => {
    if (!settingsOpen) return
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [settingsOpen])

  if (!settings.showChatButton || !pos) return null

  const showTools = hovered || settingsOpen || dragging

  return (
    <div
      ref={containerRef}
      className="fixed z-50"
      style={{ left: pos.x, top: pos.y, width: FAB_SIZE, height: FAB_SIZE }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Drag-ручка (рука) — появляется при наведении, ею перетаскивают кнопку */}
      <button
        type="button"
        aria-label="Перетащить кнопку чата"
        onPointerDown={startDrag}
        className={cn(
          "absolute -left-2 -top-2 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-all hover:text-foreground",
          dragging ? "cursor-grabbing" : "cursor-grab",
          showTools ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0",
        )}
      >
        <Hand className="size-3.5" />
      </button>

      {/* Шестерёнка — открывает попап настроек */}
      <button
        type="button"
        aria-label="Настройки кнопки чата"
        onClick={(e) => {
          e.stopPropagation()
          setSettingsOpen((v) => !v)
        }}
        className={cn(
          "absolute -right-2 -top-2 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-all hover:text-foreground",
          settingsOpen && "text-foreground",
          showTools ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0",
        )}
      >
        <Settings className="size-3.5" />
      </button>

      {/* Главная кнопка чата */}
      <button
        type="button"
        onClick={() => {
          // Не открывать чат, если это было перетаскивание.
          if (dragging) return
          onToggleChat()
        }}
        aria-label={open ? "Закрыть чат" : "Открыть чат"}
        className={cn(
          "flex size-14 items-center justify-center rounded-full shadow-lg transition-colors",
          dragging ? "cursor-grabbing" : "cursor-pointer",
          open
            ? "bg-foreground text-background hover:bg-foreground/90"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        <MessageSquare className="size-6" />
        {!open && unreadCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
            aria-label={`${unreadCount} непрочитанных сообщений`}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Попап настроек */}
      {settingsOpen && (
        <div
          className="absolute bottom-full right-0 mb-3 w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="mb-3 text-sm font-semibold">Настройки чата</h3>

          {/* Показывать кнопку чата */}
          <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm">Показывать кнопку чата</span>
            <Toggle
              checked={settings.showChatButton}
              onChange={(v) => update({ showChatButton: v })}
              label="Показывать кнопку чата"
            />
          </div>

          {/* Горячая клавиша открытия чата */}
          <div className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm">Открывать чат на кнопку</span>
            <button
              type="button"
              onClick={() => setCapturingKey(true)}
              className={cn(
                "min-w-16 rounded-md border px-3 py-1.5 text-center text-sm font-medium transition-colors",
                capturingKey
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              {capturingKey ? "Нажмите клавишу…" : keyLabel(settings.openChatKey)}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Нажмите на клавишу, чтобы переназначить. Esc — отмена.
          </p>
        </div>
      )}
    </div>
  )
}

// Небольшой переключатель в стиле проекта (отдельного UI-примитива нет).
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "inline-block size-5 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  )
}
