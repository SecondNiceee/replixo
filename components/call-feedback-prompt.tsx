"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { Frown, Meh, Smile, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  FEEDBACK_COMMENT_MAX,
  takePendingCallFeedback,
  type FeedbackRating,
  type PendingCallFeedback,
} from "@/lib/call-feedback"

const OPTIONS: { rating: FeedbackRating; label: string; Icon: LucideIcon }[] = [
  { rating: 1, label: "Плохо", Icon: Frown },
  { rating: 2, label: "Нормально", Icon: Meh },
  { rating: 3, label: "Отлично", Icon: Smile },
]

function sendFeedback(pending: PendingCallFeedback, rating: FeedbackRating, comment?: string) {
  void fetch("/api/call-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ ...pending, rating, comment }),
  }).catch(() => {})
}

export function CallFeedbackPrompt() {
  const [pending, setPending] = useState<PendingCallFeedback | null>(null)
  const [open, setOpen] = useState(false)
  const [rating, setRating] = useState<FeedbackRating | null>(null)
  const [comment, setComment] = useState("")
  const sentRef = useRef(false)

  useEffect(() => {
    const queued = takePendingCallFeedback()
    if (queued) {
      setPending(queued)
      setOpen(true)
    }
  }, [])

  if (!pending) return null

  function finish(finalRating: FeedbackRating, finalComment?: string) {
    if (!pending || sentRef.current) return
    sentRef.current = true
    sendFeedback(pending, finalRating, finalComment)
  }

  function close() {
    // A low rating is already an answer, even if the user skipped the comment.
    if (rating !== null) finish(rating, comment)
    setOpen(false)
  }

  function pick(value: FeedbackRating) {
    setRating(value)
    if (value === 3) {
      finish(3)
      setOpen(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (rating === null) return
    finish(rating, comment)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle>Как прошёл звонок?</DialogTitle>
          <DialogDescription>Ваша оценка помогает нам делать Replixo лучше.</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Оценка звонка" className="flex justify-center gap-3">
          {OPTIONS.map(({ rating: value, label, Icon }) => {
            const selected = rating === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                onClick={() => pick(value)}
                className={cn(
                  "flex size-16 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground transition",
                  "hover:scale-110 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "scale-110 border-primary bg-primary/10 text-primary",
                  rating !== null && !selected && "opacity-50",
                )}
              >
                <Icon className="size-8" strokeWidth={1.75} aria-hidden="true" />
              </button>
            )
          })}
        </div>

        {rating !== null && rating < 3 && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label htmlFor="call-feedback-comment" className="text-sm font-medium text-foreground">
              Расскажите, что бы вы хотели улучшить
            </label>
            <textarea
              id="call-feedback-comment"
              autoFocus
              rows={4}
              maxLength={FEEDBACK_COMMENT_MAX}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: пропадал звук, зависало видео…"
              className="min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit">Отправить</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
