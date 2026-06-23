"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { SendHorizonal, Check, CheckCheck, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/hooks/use-mediasoup"

interface RoomChatProps {
  open: boolean
  onClose: () => void
  messages: ChatMessage[]
  onSend: (text: string) => void
  // Index of the first message that was unread when the panel was opened.
  // Messages at this index and beyond are highlighted as "new". null = none.
  unreadFromIndex: number | null
  // peerId -> timestamp (ms) of the latest message that peer has read.
  readMarkers: Record<string, number>
  // Currently connected remote peer ids, used to decide when a message has
  // been read by everyone else in the room.
  peerIds: string[]
}

// Stable per-name color so each participant's name reads consistently.
const NAME_COLORS = [
  "text-sky-400",
  "text-emerald-400",
  "text-amber-400",
  "text-rose-400",
  "text-violet-400",
  "text-teal-400",
]

function colorForPeer(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0
  }
  return NAME_COLORS[hash % NAME_COLORS.length]
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// A message is "read" once every currently-connected peer has a read marker at
// or beyond its timestamp. With no other peers in the room it stays "delivered".
function isReadByEveryone(
  messageTs: number,
  peerIds: string[],
  readMarkers: Record<string, number>,
): boolean {
  if (peerIds.length === 0) return false
  return peerIds.every((id) => (readMarkers[id] ?? 0) >= messageTs)
}

export function RoomChat({
  open,
  onClose,
  messages,
  onSend,
  unreadFromIndex,
  readMarkers,
  peerIds,
}: RoomChatProps) {
  const [text, setText] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to the newest message whenever messages change or the panel opens.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  // Focus the input when the panel opens. We wait for the slide-in transition
  // to finish and pass preventScroll so the browser doesn't snap the still
  // off-screen input into view mid-animation, which made the open feel abrupt.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true })
    }, 300)
    return () => window.clearTimeout(id)
  }, [open])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = text.trim()
      if (!trimmed) return
      onSend(trimmed)
      setText("")
    },
    [text, onSend],
  )

  return (
    <>
      {/* Mobile backdrop — tap to dismiss */}
      <button
        aria-hidden={!open}
        tabIndex={-1}
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-20 bg-background/60 backdrop-blur-sm transition-opacity sm:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        aria-label="Чат комнаты"
        aria-hidden={!open}
        className={cn(
          "absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-border bg-card transition-transform duration-300 ease-in-out sm:w-[360px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Чат</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="size-8"
            aria-label="Закрыть чат"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <p className="text-pretty text-sm text-muted-foreground">
                Сообщений пока нет. Напишите первым!
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {messages.map((m, i) => {
                const hasUnread = unreadFromIndex !== null
                const isFirstUnread = hasUnread && i === unreadFromIndex
                const isUnread = hasUnread && i >= (unreadFromIndex as number)
                return (
                  <li key={m.id} className="flex flex-col gap-3">
                    {isFirstUnread && (
                      <div className="flex items-center gap-2" aria-hidden="true">
                        <span className="h-px flex-1 bg-primary/40" />
                        <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                          Новые сообщения
                        </span>
                        <span className="h-px flex-1 bg-primary/40" />
                      </div>
                    )}
                    <div className={cn("flex flex-col gap-0.5", m.self ? "items-end" : "items-start")}>
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "text-xs font-medium",
                            m.self ? "text-muted-foreground" : colorForPeer(m.peerId),
                          )}
                        >
                          {m.self ? "Вы" : m.displayName}
                        </span>
                        <span className="text-[10px] text-muted-foreground/70">{formatTime(m.timestamp)}</span>
                        {m.self &&
                          (isReadByEveryone(m.timestamp, peerIds, readMarkers) ? (
                            <CheckCheck className="size-3 text-sky-400" aria-label="Прочитано" />
                          ) : (
                            <Check className="size-3 text-muted-foreground/70" aria-label="Доставлено" />
                          ))}
                      </div>
                      <div
                        className={cn(
                          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed transition-shadow",
                          m.self
                            ? "rounded-br-sm bg-primary text-primary-foreground"
                            : "rounded-bl-sm bg-secondary text-secondary-foreground",
                          isUnread && !m.self && "ring-1 ring-primary/50",
                        )}
                      >
                        {m.text}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-3"
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
            placeholder="Напишите сообщение…"
            aria-label="Текст сообще��ия"
            className="h-10 flex-1 rounded-full border border-input bg-background px-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!text.trim()}
            className="size-10 shrink-0 rounded-full"
            aria-label="Отправить сообщение"
          >
            <SendHorizonal className="size-4" />
          </Button>
        </form>
      </aside>
    </>
  )
}
