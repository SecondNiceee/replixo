import { Check, CheckCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/hooks/use-mediasoup"
import { AttachmentView } from "./chat-attachment-view"
import { colorForPeer, formatTime, isReadByEveryone } from "./chat-helpers"

interface ChatMessageListProps {
  messages: ChatMessage[]
  mediaBaseUrl: string
  // Index of the first message that was unread when the panel was opened.
  // Messages at this index and beyond are highlighted as "new". null = none.
  unreadFromIndex: number | null
  // peerId -> timestamp (ms) of the latest message that peer has read.
  readMarkers: Record<string, number>
  // Currently connected remote peer ids, used to decide when a message has
  // been read by everyone else in the room.
  peerIds: string[]
}

export function ChatMessageList({
  messages,
  mediaBaseUrl,
  unreadFromIndex,
  readMarkers,
  peerIds,
}: ChatMessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-pretty text-sm text-muted-foreground">
          Сообщений пока нет. Напишите первым!
        </p>
      </div>
    )
  }

  return (
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
                  "flex max-w-[85%] flex-col gap-2 rounded-2xl px-3 py-2 text-sm leading-relaxed transition-shadow",
                  m.self
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm bg-secondary text-secondary-foreground",
                  isUnread && !m.self && "ring-1 ring-primary/50",
                )}
              >
                {m.attachment && (
                  <AttachmentView
                    attachment={m.attachment}
                    mediaBaseUrl={mediaBaseUrl}
                    self={m.self}
                  />
                )}
                {m.text && <span className="whitespace-pre-wrap break-words">{m.text}</span>}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
