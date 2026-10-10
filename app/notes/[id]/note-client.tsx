'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Download, Loader2, Pencil, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NoteDocument } from '@/components/notes/note-document'
import { NoteEditor } from '@/components/notes/note-editor'
import { ShareNoteDialog } from '@/components/notes/share-note-dialog'
import type { NoteDetail } from '@/lib/notes'

export function NoteClient({ note: initial, isOwner }: { note: NoteDetail; isOwner: boolean }) {
  const router = useRouter()
  const [note, setNote] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(initial.title)
  const [content, setContent] = useState(initial.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Не удалось сохранить')
      setNote({ ...note, title: title.trim(), content: content.trim(), updatedAt: Date.now() })
      setEditing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Удалить конспект? Он пропадёт и у тех, кому вы его отправили.')) return
    const res = await fetch(`/api/notes/${note.id}`, { method: 'DELETE' })
    if (res.ok) router.push('/profile?tab=notes')
  }

  const downloadPdf = async () => {
    setDownloading(true)
    try {
      const { downloadNotePdf } = await import('@/lib/note-pdf')
      await downloadNotePdf({
        title: note.title,
        content: note.content,
        author: note.ownerName,
        date: note.createdAt,
      })
    } catch (e) {
      console.error('PDF generation failed', e)
      window.alert('Не удалось создать PDF. Попробуйте ещё раз.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <nav className="flex flex-wrap items-center justify-between gap-3 print:hidden" aria-label="Действия с конспектом">
        <Button variant="ghost" size="sm" render={<Link href="/profile?tab=notes" />}>
          <ArrowLeft />
          Конспекты
        </Button>

        {!editing && (
          <div className="flex flex-wrap items-center gap-2">
            {isOwner && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Редактировать
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={downloadPdf} disabled={downloading}>
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}
              Скачать PDF
            </Button>
            {isOwner && (
              <Button size="sm" onClick={() => setShareOpen(true)}>
                <Send />
                Отправить
              </Button>
            )}
          </div>
        )}
      </nav>

      {editing ? (
        <section className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card p-5 text-card-foreground">
          <NoteEditor title={title} content={content} onTitleChange={setTitle}
            onContentChange={setContent}
            author={note.ownerName}
            date={note.createdAt}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" className="text-destructive" onClick={remove}>
              <Trash2 />
              Удалить
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setTitle(note.title)
                  setContent(note.content)
                  setEditing(false)
                }}
              >
                Отмена
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                Сохранить
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <NoteDocument title={note.title} content={note.content} author={note.ownerName} date={note.createdAt} />
      )}

      {isOwner && <ShareNoteDialog noteId={note.id} noteTitle={note.title} open={shareOpen} onOpenChange={setShareOpen} />}
    </div>
  )
}
