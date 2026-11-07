"use client"

import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { Copy, Reply } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

type ContextMenuOpenDetails = Parameters<NonNullable<ComponentProps<typeof ContextMenu>["onOpenChange"]>>[1]

interface MessageContextMenuProps {
  children: ReactNode
  /** Можно ли ответить на это сообщение (например, ещё не отправленное — нельзя). */
  canReply: (messageId: string) => boolean
  /** Текст сообщения для «Копировать»; пустая строка — пункта нет. */
  getText: (messageId: string) => string
  onReply: (messageId: string) => void
}

/**
 * Своё меню по правому клику (и долгому нажатию на тач-экране) вместо
 * системного. Одно меню на всю ленту: на какое сообщение нажали, узнаём по
 * ближайшему [data-message-id]. Клик мимо сообщений меню не открывает.
 */
export function MessageContextMenu({ children, canReply, getText, onReply }: MessageContextMenuProps) {
  const [open, setOpen] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  // Выделенный в момент клика текст: после открытия меню фокус уходит в него,
  // и браузер может выделение сбросить.
  const selectionRef = useRef("")

  const handleOpenChange = useCallback(
    (next: boolean, details: ContextMenuOpenDetails) => {
      if (next) {
        // Целевое сообщение берём прямо из события открытия — не зависим от
        // порядка, в котором base-ui и мы обрабатываем contextmenu.
        const target = details.event?.target
        const el = target instanceof Element ? target.closest<HTMLElement>("[data-message-id]") : null
        const id = el?.dataset.messageId
        if (!el || !id) return
        const selection = window.getSelection()
        selectionRef.current =
          selection && !selection.isCollapsed && el.contains(selection.anchorNode) ? selection.toString() : ""
        setTargetId(id)
      }
      setOpen(next)
    },
    [],
  )

  const text = targetId ? getText(targetId) : ""
  const copyText = selectionRef.current || text
  const replyAllowed = targetId ? canReply(targetId) : false

  return (
    <ContextMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!replyAllowed} onClick={() => targetId && onReply(targetId)}>
          <Reply />
          Ответить
        </ContextMenuItem>
        {copyText && (
          <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(copyText).catch(() => {})}>
            <Copy />
            {selectionRef.current ? "Копировать выделенное" : "Копировать текст"}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
