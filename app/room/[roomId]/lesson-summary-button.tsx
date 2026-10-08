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

interface LessonSummaryButtonProps {
  roomId: string
  localStream: MediaStream | null
  peers: Map<string, RemotePeer>
}

function defaultTitle() {
  return `Урок ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}`
}

export function LessonSummaryButton({ roomId, localStream, peers }: LessonSummaryButtonProps) {
  const audioKey = [localStream?.id, ...[...peers.values()].map((p) => p.audioStream?.id)].join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const streams = useMemo(
    () => [localStream, ...[...peers.values()].map((p) => p.audioStream)].filter((s): s is MediaStream => !!s),
    [audioKey],
  )
  const { status, summary, error, start, stop } = useLessonRecorder(streams)
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

  const recording = status === "recording"
  const summarizing = status === "summarizing"

  const handleClick = () => {
    if (recording) void stop()
    else if (!summarizing) void start()
  }

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

      <Dialog open={open} onOpenChange={setOpen}>
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

      <ShareNoteDialog noteId={savedId} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  )
}
