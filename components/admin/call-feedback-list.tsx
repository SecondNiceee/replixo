"use client"

import { useState } from "react"
import { Frown, Meh, Smile } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CallFeedbackRow } from "@/app/api/adminuw102/route"

const RATING = {
  1: { label: "Плохо", Icon: Frown, className: "text-destructive" },
  2: { label: "Нормально", Icon: Meh, className: "text-muted-foreground" },
  3: { label: "Отлично", Icon: Smile, className: "text-primary" },
} as const

type Filter = "all" | 1 | 2 | 3

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

export function CallFeedbackList({ feedback }: { feedback: CallFeedbackRow[] }) {
  const [filter, setFilter] = useState<Filter>("all")
  const counts = { 1: 0, 2: 0, 3: 0 }
  for (const f of feedback) counts[f.rating]++
  const visible = filter === "all" ? feedback : feedback.filter((f) => f.rating === filter)

  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: `Все · ${feedback.length}` },
    { value: 3, label: `Отлично · ${counts[3]}` },
    { value: 2, label: `Нормально · ${counts[2]}` },
    { value: 1, label: `Плохо · ${counts[1]}` },
  ]

  return (
    <section aria-labelledby="feedback-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="feedback-heading" className="text-xl font-semibold tracking-tight text-foreground">
          Отзывы о звонках
        </h2>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "rounded-full border border-border px-3 py-1 text-sm transition",
                filter === f.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground">Отзывов пока нет.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((f) => {
            const { label, Icon, className } = RATING[f.rating]
            return (
              <li key={f.id} className="flex gap-4 rounded-lg border border-border p-4">
                <Icon className={cn("size-7 shrink-0", className)} aria-label={label} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-medium text-foreground">{f.userName ?? "Гость"}</span>
                    {f.userEmail && <span className="text-muted-foreground">{f.userEmail}</span>}
                    <span className="text-muted-foreground">{dateFormat.format(new Date(f.createdAt))}</span>
                    <span className="text-muted-foreground">{Math.round(f.durationSec / 60)} мин</span>
                    <span className="font-mono text-muted-foreground">{f.roomId}</span>
                  </div>
                  {f.comment ? (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                      {f.comment}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{label}, без комментария</p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
