"use client"

import { Reply, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { replyPreview, scrollToMessage, type ReplyRef } from "@/lib/chat/reply"

/** Имя автора цитаты: свои сообщения подписываем «Вы», как в ленте. */
function authorLabel(reply: ReplyRef, selfAuthorId: string): string {
  return reply.authorId === selfAuthorId ? "Вы" : reply.author || "Участник"
}

/**
 * Цитата внутри пузыря. Кнопка, а не просто блок: клик возвращает к оригиналу.
 * На своём (цветном) пузыре цвета берутся от его текста, на чужом — от акцента.
 */
export function ReplyQuote({
  reply,
  selfAuthorId,
  self,
  className,
}: {
  reply: ReplyRef
  selfAuthorId: string
  /** Цитата лежит в моём пузыре. */
  self: boolean
  className?: string
}) {
  const author = authorLabel(reply, selfAuthorId)
  return (
    <button
      type="button"
      onClick={() => scrollToMessage(reply.id)}
      aria-label={`Перейти к сообщению: ${author}`}
      className={cn(
        "flex min-w-0 flex-col items-start rounded-md border-l-2 px-2 py-1 text-left text-xs transition-colors",
        self
          ? "border-current/60 bg-current/10 hover:bg-current/15"
          : "border-primary bg-primary/10 hover:bg-primary/15",
        className,
      )}
    >
      <span className={cn("max-w-full truncate font-medium", !self && "text-primary")}>{author}</span>
      <span className="line-clamp-2 max-w-full break-words opacity-80">{replyPreview(reply)}</span>
    </button>
  )
}

/** Плашка «Ответ на …» над полем ввода, с отменой. */
export function ReplyComposerBar({
  reply,
  selfAuthorId,
  onCancel,
}: {
  reply: ReplyRef
  selfAuthorId: string
  onCancel: () => void
}) {
  const author = authorLabel(reply, selfAuthorId)
  return (
    <div className="flex items-center gap-2 px-3 pt-3">
      <Reply className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <button
        type="button"
        onClick={() => scrollToMessage(reply.id)}
        className="flex min-w-0 flex-1 flex-col border-l-2 border-primary pl-2 text-left"
        aria-label={`Ответ на сообщение ${author}. Показать оригинал`}
      >
        <span className="truncate text-xs font-medium text-primary">Ответ {author}</span>
        <span className="truncate text-xs text-muted-foreground">{replyPreview(reply)}</span>
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        aria-label="Отменить ответ"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
