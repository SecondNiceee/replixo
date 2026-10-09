'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Loader2, NotebookText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fetcher } from '@/app/profile/types'

interface NoteItem {
  id: string
  title: string
  updatedAt: string
}

interface NotePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (note: { id: string; title: string }) => Promise<void>
}

export function NotePickerDialog({ open, onOpenChange, onPick }: NotePickerDialogProps) {
  const { data, isLoading } = useSWR<{ own: NoteItem[] }>(open ? '/api/notes' : null, fetcher)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const notes = data?.own ?? []

  const pick = async (note: NoteItem) => {
    setSendingId(note.id)
    setError(null)
    try {
      await onPick(note)
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSendingId(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Отправить конспект</DialogTitle>
          <DialogDescription>Выберите конспект — он придёт в этот чат карточкой.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50dvh] overflow-y-auto rounded-lg border border-border">
          {isLoading ? (
            <div className="flex items-center justify-center p-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">Загрузка конспектов</span>
            </div>
          ) : notes.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Конспектов пока нет. Они появятся после первого урока с ИИ-конспектом.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {notes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => pick(note)}
                    disabled={sendingId !== null}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <NotebookText className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{note.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(note.updatedAt).toLocaleDateString('ru-RU', {
                          day: 'numeric',
                          month: 'long',
                        })}
                      </span>
                    </span>
                    {sendingId === note.id && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
