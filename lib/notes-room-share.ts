import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

// Подпись ссылки на конспект, отправленный в чат комнаты.
// Подробнее о схеме — в lib/chat/note-attachment.ts.

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET
  if (!value) throw new Error('BETTER_AUTH_SECRET is not set')
  return value
}

export function isValidRoomId(roomId: string): boolean {
  return ROOM_ID_RE.test(roomId)
}

export function signRoomNote(noteId: string, roomId: string): string {
  return createHmac('sha256', secret()).update(`room-note:${noteId}:${roomId}`).digest('hex')
}

export function verifyRoomNote(noteId: string, roomId: string, sig: string): boolean {
  if (!isValidRoomId(roomId) || !/^[0-9a-f]{64}$/i.test(sig)) return false
  const expected = Buffer.from(signRoomNote(noteId, roomId), 'hex')
  const given = Buffer.from(sig, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function roomNoteUrl(noteId: string, roomId: string): string {
  return `/notes/${noteId}?room=${roomId}&sig=${signRoomNote(noteId, roomId)}`
}
