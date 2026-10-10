"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ExternalLink, FileText, Loader2, Send, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useLessonRecorder } from "@/hooks/use-lesson-recorder"
import { NoteEditor } from "@/components/notes/note-editor"
import { extractTopic } from "@/components/notes/note-document"
import { ShareNoteDialog } from "@/components/notes/share-note-dialog"
import type { RemotePeer } from "@/hooks/mediasoup/types"

export type LessonSummaryRecorder = ReturnType<typeof useLessonRecorder>

function defaultTitle() {
  return `Урок ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`
}

/**
 * Запись для конспекта. Вызывается в RoomClient, который смонтирован всё время
 * звонка: панель управления (а с ней и кнопка) исчезает в overlay-режиме
 * Electron во время демонстрации экрана, и запись не должна от этого сбрасываться.
 */
export function useLessonSummary(localStream: MediaStream | null, peers: Map<string, RemotePeer>) {
  const audioKey = [localStream?.id, ...[...peers.values()].map((p) => p.audioStream?.id)].join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const streams = useMemo(
    () => [localStream, ...[...peers.values()].map((p) => p.audioStream)].filter((s): s is MediaStream => !!s),
    [audioKey],
  )
  return useLessonRecorder(streams)
}

const LOCKED_HINT = "Зарегистрируйтесь для того, чтобы создавать ИИ-конспекты ваших уроков"

/** Неактивная кнопка для гостей: показывает, что функция есть, и зовёт зарегистрироваться. */
export function LessonSummaryLockedButton() {
  return (
    <span
      tabIndex={0}
      aria-describedby="lesson-summary-locked-hint"
      className="group relative inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Button
        variant="outline"
        size="icon"
        disabled
        tabIndex={-1}
        aria-label="ИИ-конспект урока недоступен без регистрации"
        className="pointer-events-none size-12 rounded-full"
      >
        <FileText className="size-5" />
      </Button>
      <span
        id="lesson-summary-locked-hint"
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-3 w-60 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-center text-xs leading-relaxed text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {LOCKED_HINT}
      </span>
    </span>
  )
}

export function LessonSummaryButton({ recorder }: { recorder: LessonSummaryRecorder }) {
  const { status, start, stop } = recorder
  const recording = status === "recording"
  const summarizing = status === "summarizing"

  const handleClick = () => {
    if (recording) void stop()
    else if (!summarizing) void start()
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={handleClick}
      disabled={summarizing}
      aria-busy={summarizing}
      className={cn(
        "size-12 rounded-full",
        recording && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
      )}
      aria-label={
        summarizing
          ? "Составляем конспект…"
          : recording
            ? "Закончить запись и составить конспект"
            : "Начать запись для ИИ-конспекта"
      }
      title={recording ? "Идёт запись урока. Нажмите, чтобы получить конспект" : "ИИ-конспект урока"}
    >
      {summarizing ? (
        <Loader2 className="size-5 animate-spin" />
      ) : recording ? (
        <Square className="size-4 animate-pulse fill-current" />
      ) : (
        <FileText className="size-5" />
      )}
    </Button>
  )
}

interface LessonSummaryDialogsProps {
  recorder: LessonSummaryRecorder
  roomId: string
  /** Скрыть окно (overlay-режим), не теряя черновик. */
  hidden?: boolean
}

export function LessonSummaryDialogs({ recorder, roomId, hidden = false }: LessonSummaryDialogsProps) {
  const { status, summary, error } = recorder
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)

  useEffect(() => {
    if (status === "done") {
      setTitle(extractTopic(summary) ?? defaultTitle())
      setContent(summary)
      setSavedId(null)
      setSaveError(null)
      setOpen(true)
    } else if (status === "error") {
      setOpen(true)
    }
  }, [status, summary])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(savedId ? `/api/notes/${savedId}` : "/api/notes", {
        method: savedId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, roomId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Не удалось сохранить")
      if (!savedId) setSavedId(json.id)
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open && !hidden} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Конспект урока</DialogTitle>
            <DialogDescription>
              {"Черновик составлен ИИ. Поправьте его и нажмите «Сохранить» — конспект появится в разделе «Конспекты»."}
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <NoteEditor
              title={title}
              content={content}
              onTitleChange={(v) => setTitle(v)}
              onContentChange={(v) => setContent(v)}
            />
          )}

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {savedId && !saveError && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
              <Check className="size-4 text-primary" />
              Сохранено в «Конспекты»
            </p>
          )}

          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Закрыть
            </Button>
            {!error && savedId && (
              <>
                <Button variant="outline" render={<a href={`/notes/${savedId}`} target="_blank" rel="noreferrer" />}>
                  <ExternalLink />
                  Открыть страницу
                </Button>
                <Button variant="outline" onClick={() => setShareOpen(true)}>
                  <Send />
                  Отправить
                </Button>
              </>
            )}
            {!error && (
              <Button onClick={save} disabled={saving || !title.trim() || !content.trim()}>
                {saving && <Loader2 className="animate-spin" />}
                Сохранить
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareNoteDialog
        noteId={savedId}
        noteTitle={title}
        open={shareOpen && !hidden}
        onOpenChange={setShareOpen}
      />
    </>
  )
}
