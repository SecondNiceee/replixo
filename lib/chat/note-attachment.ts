// Конспект в чате передаётся как вложение особого типа: ссылка на страницу
// /notes/<id> внутри приложения, а не файл на сокет-сервере.
//
// Личный чат: доступ выдаёт /api/notes/[id]/share (lessonNoteShare), поэтому
// голая ссылка без отправки ничего не открывает.
//
// Чат комнаты: участники звонка не обязательно друзья и на сокете у них нет
// userId, поэтому выдать доступ заранее некому. Вместо этого владелец получает
// от /api/notes/[id]/room-share ссылку с подписью ?room=&sig= — HMAC от пары
// (noteId, roomId). Страница конспекта, увидев валидную подпись, сама выдаёт
// доступ вошедшему зрителю. Подделать подпись без секрета нельзя, а знать код
// комнаты = быть участником звонка (так же устроены и файлы комнаты).

export const NOTE_ATTACHMENT_MIME = 'application/x-replixo-note'

const NOTE_URL_RE = /^\/notes\/[0-9a-f-]{36}(\?room=[A-Za-z0-9_-]{1,64}&sig=[0-9a-f]{64})?$/i

export interface NoteAttachment {
  url: string
  name: string
  size: number
  mime: string
}

export function noteAttachment(noteId: string, title: string, url = `/notes/${noteId}`): NoteAttachment {
  return {
    url,
    name: (title || 'Конспект урока').slice(0, 200),
    size: 0,
    mime: NOTE_ATTACHMENT_MIME,
  }
}

export function isNoteAttachment(a: { url: string; mime: string }): boolean {
  return a.mime === NOTE_ATTACHMENT_MIME && NOTE_URL_RE.test(a.url)
}
