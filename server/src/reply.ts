// Снимок цитаты при ответе на сообщение. Форма совпадает с lib/chat/reply.ts
// в Next-приложении: { id, authorId, author, text, attachmentName }.

export const REPLY_TEXT_LIMIT = 200

export interface MessageReply {
  id: string
  authorId: string
  author: string
  text: string
  attachmentName: string | null
}

function clip(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

/** Привести присланную клиентом цитату к известной форме; кривую — в null. */
export function sanitizeReply(raw: unknown): MessageReply | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = clip(r.id, 64)
  const authorId = clip(r.authorId, 128)
  const author = clip(r.author, 80)
  if (!id || !authorId || author === null) return null
  return {
    id,
    authorId,
    author,
    text: (clip(r.text, REPLY_TEXT_LIMIT) ?? '').trim(),
    attachmentName: clip(r.attachmentName, 120),
  }
}
