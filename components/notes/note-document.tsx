'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Block =
  | { type: 'heading'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'para'; text: string }

/** Тема из строки «Тема урока: …» — по ней предзаполняется заголовок. */
export function extractTopic(content: string): string | null {
  const m = content.match(/^\s*\**\s*Тема урока\s*\**\s*:\s*\**\s*(.+?)\**\s*$/im)
  return m?.[1]?.trim() || null
}

/**
 * Конспект хранится обычным текстом в формате, который выдаёт ИИ:
 * «Раздел:» — заголовок, «- пункт» — список. Так его легко править в
 * textarea, а здесь он превращается в свёрстанный документ.
 */
export function parseNote(content: string): Block[] {
  const blocks: Block[] = []
  let list: { type: 'bullets'; items: string[] } | null = null

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()
    if (!line) {
      list = null
      continue
    }
    const bullet = line.match(/^(?:[-•*–]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      if (!list) {
        list = { type: 'bullets', items: [] }
        blocks.push(list)
      }
      list.items.push(bullet[1])
      continue
    }
    list = null
    if (/^тема урока\s*:/i.test(line)) continue
    const heading = line.match(/^([^:]{2,80}):\s*(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', text: heading[1] })
      if (heading[2]) blocks.push({ type: 'para', text: heading[2] })
      continue
    }
    blocks.push({ type: 'para', text: line })
  }
  return blocks
}

// Страница вёрстается в размере A4 при 96 dpi и масштабируется под ширину экрана,
// поэтому разбивка на страницы одинакова везде и близка к скачиваемому PDF.
const PAGE_W = 794
const PAGE_H = 1123
const PAD_X = 72
const PAD_Y = 64
const FOOTER_H = 40
const CONTENT_H = PAGE_H - PAD_Y * 2 - FOOTER_H

type Unit = { kind: 'heading' | 'para' | 'bullet'; text: string }

/** Списки дробятся на отдельные пункты, чтобы длинный список мог перейти на следующую страницу. */
function toUnits(blocks: Block[]): Unit[] {
  return blocks.flatMap((b): Unit[] =>
    b.type === 'bullets' ? b.items.map((text) => ({ kind: 'bullet', text })) : [{ kind: b.type, text: b.text }],
  )
}

function UnitView({ unit, first }: { unit: Unit; first: boolean }) {
  if (unit.kind === 'heading') {
    return (
      <h2 className={cn('text-sm font-semibold uppercase tracking-[0.12em] text-primary', first ? 'pb-1' : 'pt-7 pb-1')}>
        {unit.text}
      </h2>
    )
  }
  if (unit.kind === 'bullet') {
    return (
      <div className="flex gap-3 pt-2 text-pretty text-base leading-relaxed">
        <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <span>{unit.text}</span>
      </div>
    )
  }
  return <p className="pt-3 text-pretty text-base leading-relaxed">{unit.text}</p>
}

function DocHeader({ title, author, date }: { title: string; author: string; date: string }) {
  return (
    <header className="flex flex-col gap-4 border-b border-paper-rule pb-8 mb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Конспект урока</p>
      <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight">{title}</h1>
      <p className="text-sm text-paper-muted">
        {author ? `${author} · ` : ''}
        {date}
      </p>
    </header>
  )
}

function paginate(units: Unit[], headerH: number, heights: number[]): number[][] {
  const pages: number[][] = [[]]
  let used = headerH
  units.forEach((unit, i) => {
    const page = pages[pages.length - 1]
    // Заголовок не остаётся один внизу страницы — переносится вместе со следующим блоком.
    const need = heights[i] + (unit.kind === 'heading' && i + 1 < units.length ? heights[i + 1] : 0)
    if (used + need > CONTENT_H && page.length > 0) {
      pages.push([i])
      used = heights[i]
      return
    }
    page.push(i)
    used += heights[i]
  })
  return pages
}

function Page({ scale, number, total, children }: { scale: number; number: number; total: number; children: ReactNode }) {
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-lg shadow-2xl"
      style={{ width: PAGE_W * scale, height: PAGE_H * scale }}
    >
      <section
        aria-label={`Страница ${number} из ${total}`}
        className="absolute left-0 top-0 flex flex-col bg-paper text-paper-foreground"
        style={{
          width: PAGE_W,
          height: PAGE_H,
          padding: `${PAD_Y}px ${PAD_X}px`,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <div className="flex-1">{children}</div>
        <footer
          className="flex items-end justify-between border-t border-paper-rule text-xs text-paper-muted"
          style={{ height: FOOTER_H }}
        >
          <span>Составлено в Replixo</span>
          <span>
            {number} / {total}
          </span>
        </footer>
      </section>
    </div>
  )
}

export function NoteDocument({
  title,
  content,
  author = '',
  date,
  className,
}: {
  title: string
  content: string
  author?: string
  date: number
  className?: string
}) {
  const units = toUnits(parseNote(content))
  const formatted = new Date(date).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const wrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [pages, setPages] = useState<number[][] | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setScale(Math.min(1, el.clientWidth / PAGE_W))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const box = measureRef.current
    if (!box) return
    const measure = () => {
      const [header, ...rest] = Array.from(box.children) as HTMLElement[]
      const headerH = header.getBoundingClientRect().height + 24
      setPages(paginate(units, headerH, rest.map((n) => n.getBoundingClientRect().height)))
    }
    measure()
    let cancelled = false
    document.fonts?.ready.then(() => !cancelled && measure())
    return () => {
      cancelled = true
    }
    // units пересоздаётся из content/title на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, title, author, formatted])

  const pageList = pages ?? [units.map((_, i) => i)]

  return (
    <div ref={wrapRef} className={cn('note-paper relative flex w-full flex-col items-center gap-6', className)}>
      <div aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 size-0 overflow-hidden">
        <div ref={measureRef} className="flex flex-col" style={{ width: PAGE_W - PAD_X * 2 }}>
          <DocHeader title={title} author={author} date={formatted} />
          {units.map((unit, i) => (
            <div key={i}>
              <UnitView unit={unit} first={false} />
            </div>
          ))}
        </div>
      </div>

      {pageList.map((indexes, p) => (
        <Page key={p} scale={scale} number={p + 1} total={pageList.length}>
          {p === 0 && <DocHeader title={title} author={author} date={formatted} />}
          {indexes.map((i, k) => (
            <UnitView key={i} unit={units[i]} first={k === 0 && p > 0} />
          ))}
        </Page>
      ))}
    </div>
  )
}
