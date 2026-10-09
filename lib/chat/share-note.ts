'use client'

import type { Socket } from 'socket.io-client'
import { noteAttachment } from './note-attachment'

function messageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Выдать друзьям доступ к конспекту и положить его карточкой в их личные чаты.
 * Доступ выдаётся всегда; сообщение в чат — если есть живой сокет (без него
 * получатели всё равно увидят конспект во вкладке «Конспекты»).
 */
export async function shareNoteWithFriends(
  note: { id: string; title: string },
  userIds: string[],
  socket: Socket | null,
): Promise<number> {
  const res = await fetch(`/api/notes/${note.id}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    error?: string
    shared?: number
    conversationIds?: string[]
  }
  if (!res.ok) throw new Error(json.error || 'Не удалось отправить')

  if (socket?.connected) {
    const attachment = noteAttachment(note.id, note.title)
    for (const conversationId of json.conversationIds ?? []) {
      socket.emit('dm:send', { conversationId, id: messageId(), text: '', attachment })
    }
  }
  return json.shared ?? 0
}
