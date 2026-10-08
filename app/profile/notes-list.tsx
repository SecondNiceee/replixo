'use client'

import Link from 'next/link'
import useSWR from 'swr'
import { FileText, Loader2 } from 'lucide-react'
import type { NoteListItem } from '@/lib/notes'
import { fetcher } from './types'

interface NotesResponse {
  own: NoteListItem[]
  shared: NoteListItem[]
  isTeacher: boolean
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function NoteRow({ note }: { note: NoteListItem }) {
  return (
    <li>
      <Link
        href={`/notes/${note.id}`}
        className="flex gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/50"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <FileText className="size-4" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">{note.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatDate(note.updatedAt)}</span>
          </span>
          <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {note.ownerName ? `${note.ownerName} · ` : ''}
            {note.preview}
          </span>
        </span>
      </Link>
    </li>
  )
}

function Section({ title, notes }: { title: string; notes: NoteListItem[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-3 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      <ul className="flex flex-col">
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}
      </ul>
    </section>
  )
}

export function NotesList() {
  const { data, isLoading } = useSWR<NotesResponse>('/api/notes', fetcher)

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="sr-only">Загрузка конспектов</span>
      </div>
    )
  }

  const { own, shared, isTeacher } = data
  if (own.length === 0 && shared.length === 0) {
    return (
      <p className="p-6 text-center text-sm leading-relaxed text-muted-foreground">
        {isTeacher
          ? 'Конспектов пока нет. Во время урока нажмите кнопку «ИИ-конспект» внизу экрана, а затем «Сохранить».'
          : 'Здесь появятся конспекты, которые пришлёт преподаватель.'}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {isTeacher && own.length > 0 && <Section title="Мои конспекты" notes={own} />}
      {shared.length > 0 && <Section title="Присланные мне" notes={shared} />}
    </div>
  )
}
