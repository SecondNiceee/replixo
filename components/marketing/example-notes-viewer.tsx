"use client"

import { useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NoteDocument } from "@/components/notes/note-document"
import { downloadNotePdf } from "@/lib/note-pdf"
import { EXAMPLE_NOTES } from "@/lib/example-notes"
import { cn } from "@/lib/utils"

export function ExampleNotesViewer() {
  const [activeId, setActiveId] = useState(EXAMPLE_NOTES[0].id)
  const [downloading, setDownloading] = useState<string | null>(null)
  const note = EXAMPLE_NOTES.find((n) => n.id === activeId) ?? EXAMPLE_NOTES[0]

  async function handleDownload(id: string) {
    const target = EXAMPLE_NOTES.find((n) => n.id === id)
    if (!target) return
    setDownloading(id)
    try {
      await downloadNotePdf(target)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <section aria-label="Примеры конспектов" className="border-t border-border px-6 py-14 sm:py-20">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <div className="flex flex-col gap-2 lg:sticky lg:top-8 lg:self-start" role="tablist" aria-label="Выберите урок">
          {EXAMPLE_NOTES.map((item) => {
            const active = item.id === activeId
            return (
              <div
                key={item.id}
                className={cn(
                  "flex flex-col gap-3 rounded-md border p-4 transition-colors",
                  active ? "border-foreground/30 bg-muted/40" : "border-border hover:border-foreground/20",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveId(item.id)}
                  className="flex flex-col gap-1 text-left"
                >
                  <span className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    {item.subject}
                  </span>
                  <span className="font-medium text-foreground">{item.title}</span>
                  <span className="text-sm text-muted-foreground">Урок {item.duration}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDownload(item.id)}
                  disabled={downloading === item.id}
                  className="flex items-center gap-2 self-start text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-60"
                >
                  {downloading === item.id ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="size-4" aria-hidden="true" />
                  )}
                  Скачать PDF
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex min-w-0 flex-col gap-4" role="tabpanel">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Конспект в том виде, в каком его получает ученик
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-2 rounded-md"
              onClick={() => handleDownload(note.id)}
              disabled={downloading === note.id}
            >
              {downloading === note.id ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              PDF
            </Button>
          </div>
          <NoteDocument key={note.id} title={note.title} content={note.content} author={note.author} date={note.date} />
        </div>
      </div>
    </section>
  )
}
