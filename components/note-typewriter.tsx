"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type Line = { kind: "title" | "heading" | "bullet" | "para"; text: string }

const lines: Line[] = [
  { kind: "title", text: "Квадратные уравнения" },
  { kind: "heading", text: "Что разобрали" },
  { kind: "bullet", text: "Общий вид: ax² + bx + c = 0, где a ≠ 0" },
  { kind: "bullet", text: "Дискриминант D = b² − 4ac и что он показывает" },
  { kind: "bullet", text: "Если D < 0, действительных корней нет" },
  { kind: "heading", text: "Пример с урока" },
  { kind: "para", text: "x² − 5x + 6 = 0 → D = 1, корни x₁ = 2 и x₂ = 3" },
  { kind: "heading", text: "Домашнее задание" },
  { kind: "bullet", text: "№ 412, 415 (а, в), 418" },
  { kind: "bullet", text: "Повторить теорему Виета" },
]

const totalChars = lines.reduce((sum, line) => sum + line.text.length, 0)
const CHAR_MS = 28
const HOLD_MS = 4500

export function NoteTypewriter() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState(0)
  const [visible, setVisible] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    const node = rootRef.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.35,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (reducedMotion || !visible) return
    const done = typed >= totalChars
    const timer = window.setTimeout(
      () => setTyped(done ? 0 : typed + 1),
      done ? HOLD_MS : CHAR_MS,
    )
    return () => window.clearTimeout(timer)
  }, [typed, visible, reducedMotion])

  const shown = reducedMotion ? totalChars : typed
  const finished = shown >= totalChars

  let offset = 0
  const rendered = lines.map((line) => {
    const start = offset
    offset += line.text.length
    const count = Math.max(0, Math.min(line.text.length, shown - start))
    const caret = !finished && shown >= start && shown < start + line.text.length
    return { line, count, caret }
  })

  return (
    <div ref={rootRef} className="relative">
      <figure
        aria-label="Пример конспекта урока: квадратные уравнения"
        className="rounded-md border border-border bg-card shadow-[0_24px_60px_-30px_oklch(0_0_0/0.8)]"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <span className="font-mono text-xs text-muted-foreground">Алгебра · 8 класс · 1 ч 24 мин</span>
          <span className="font-mono text-xs text-muted-foreground" aria-hidden="true">
            {finished ? "готово" : "пишется…"}
          </span>
        </div>

        <div className="flex flex-col px-6 pb-6 pt-5 sm:px-8" aria-hidden="true">
          {rendered.map(({ line, count, caret }, index) => (
            <TypedLine key={index} line={line} count={count} caret={caret} />
          ))}
        </div>

        <div
          aria-hidden="true"
          className={cn(
            "flex items-center gap-2 border-t border-border px-6 py-3 transition-opacity duration-500",
            finished ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
            Скачать PDF
          </span>
          <span className="rounded-sm border border-border px-3 py-1.5 text-xs font-medium text-foreground">
            Отправить ученику
          </span>
        </div>

        <figcaption className="sr-only">
          {lines.map((line) => line.text).join(". ")}
        </figcaption>
      </figure>
    </div>
  )
}

function TypedLine({ line, count, caret }: { line: Line; count: number; caret: boolean }) {
  const typedText = line.text.slice(0, count)
  const restText = line.text.slice(count)

  const content = (
    <>
      {typedText}
      {caret && (
        <span className="ml-px inline-block h-[1.05em] w-0.5 translate-y-[0.15em] bg-foreground align-baseline" />
      )}
      <span className="text-transparent">{restText}</span>
    </>
  )

  if (line.kind === "title") {
    return <p className="text-xl font-semibold tracking-tight text-foreground">{content}</p>
  }
  if (line.kind === "heading") {
    return (
      <p className="pb-1 pt-5 text-xs font-semibold uppercase tracking-[0.12em] text-foreground">
        {content}
      </p>
    )
  }
  if (line.kind === "bullet") {
    return (
      <p className="flex gap-2.5 py-0.5 text-sm leading-relaxed text-muted-foreground">
        <span className={cn("select-none", count === 0 && "text-transparent")}>–</span>
        <span>{content}</span>
      </p>
    )
  }
  return <p className="py-0.5 font-mono text-sm leading-relaxed text-muted-foreground">{content}</p>
}
