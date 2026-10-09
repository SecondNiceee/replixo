// Конспект в личном чате передаётся как вложение особого типа: ссылка на
// страницу /notes/<id> внутри приложения, а не файл на сокет-сервере. Доступ к
// самой странице решает lessonNoteShare, поэтому ссылка без отправки через
// /api/notes/[id]/share ничего не открывает.

export const NOTE_ATTACHMENT_MIME = 'application/x-replixo-note'

const NOTE_URL_RE = /^\/notes\/[0-9a-f-]{36}$/i

export interface NoteAttachment {
  url: string
  name: string
  size: number
  mime: string
}

export function noteAttachment(noteId: string, title: string): NoteAttachment {
  return {
    url: `/notes/${noteId}`,
    name: (title || 'Конспект урока').slice(0, 200),
    size: 0,
    mime: NOTE_ATTACHMENT_MIME,
  }
}

export function isNoteAttachment(a: { url: string; mime: string }): boolean {
  return a.mime === NOTE_ATTACHMENT_MIME && NOTE_URL_RE.test(a.url)
}
