"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { MessageSquare, Settings, Hand } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChatButtonStore } from "@/stores/chat-button-store"
import { ChatButtonSettingsDialog } from "./chat-button-settings"

interface FloatingChatButtonProps {
  chatOpen: boolean
  unreadCount: number
  onToggleChat: () => void
}

// Size of the button in px — used to clamp the draggable position so the button
// never escapes the viewport.
const BTN_SIZE = 56

export function FloatingChatButton({
  chatOpen,
  unreadCount,
  onToggleChat,
}: FloatingChatButtonProps) {
  const { xRatio, yRatio, visible, setPosition } = useChatButtonStore()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Mounted guard: the store rehydrates from localStorage on the client, so we
  // avoid rendering until after mount to keep SSR and first paint consistent.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const containerRef = useRef<HTMLDivElement>(null)
  // Offset between the pointer and the button's top-left corner at drag start,
  // so the button doesn't "jump" to center under the cursor.
  const grabOffset = useRef({ x: 0, y: 0 })

  const commitFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const maxX = window.innerWidth - BTN_SIZE
      const maxY = window.innerHeight - BTN_SIZE
      const left = Math.min(Math.max(0, clientX - grabOffset.current.x), maxX)
      const top = Math.min(Math.max(0, clientY - grabOffset.current.y), maxY)
      setPosition(maxX > 0 ? left / maxX : 0, maxY > 0 ? top / maxY : 0)
    },
    [setPosition],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent) => commitFromClient(e.clientX, e.clientY),
    [commitFromClient],
  )

  const endDrag = useCallback(() => {
    setDragging(false)
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", endDrag)
  }, [onPointerMove])

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        grabOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      }
      setDragging(true)
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", endDrag)
    },
    [onPointerMove, endDrag],
  )

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", endDrag)
    }
  }, [onPointerMove, endDrag])

  if (!mounted || !visible) return null

  // Translate stored ratios into absolute pixel coordinates within the viewport.
  const left = xRatio * Math.max(0, window.innerWidth - BTN_SIZE)
  const top = yRatio * Math.max(0, window.innerHeight - BTN_SIZE)

  return (
    <>
      <div
        ref={containerRef}
        className="group/fab fixed z-40 touch-none"
        style={{ left, top, width: BTN_SIZE, height: BTN_SIZE }}
      >
        {/* Hover controls: drag handle (hand) on the left, gear on the right.
            They fade in on hover/focus-within and while dragging. */}
        <div
          className={cn(
            "pointer-events-none absolute -top-9 left-1/2 flex -translate-x-1/2 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/fab:opacity-100 group-focus-within/fab:opacity-100",
            dragging && "opacity-100",
          )}
        >
          {/* Drag handle */}
          <button
            type="button"
            onPointerDown={startDrag}
            aria-label="Перетащить кнопку чата"
            className={cn(
              "pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
          >
            <Hand className="size-4" />
          </button>
          {/* Settings gear */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Настройки кнопки чата"
            className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings className="size-4" />
          </button>
        </div>

        {/* The chat button itself */}
        <button
          type="button"
          onClick={() => {
            if (!dragging) onToggleChat()
          }}
          aria-label={chatOpen ? "Закрыть чат" : "Открыть чат"}
          className={cn(
            "relative flex size-14 items-center justify-center rounded-full border shadow-lg transition-colors",
            chatOpen
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-background text-foreground hover:bg-accent",
          )}
        >
          <MessageSquare className="size-6" />
          {!chatOpen && unreadCount > 0 && (
            <span
              className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
              aria-label={`${unreadCount} непрочитанных сообщений`}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </div>

      <ChatButtonSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}
