import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { lessonNote, lessonNoteShare, user } from '@/lib/db/schema'

export const MAX_NOTE_TITLE = 200
export const MAX_NOTE_CONTENT = 50_000

export interface NoteListItem {
  id: string
  title: string
  preview: string
  updatedAt: number
  ownerName: string | null
}

export interface NoteDetail {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
  ownerId: string
  ownerName: string
}

function displayName(username: string | null, name: string | null) {
  return username?.trim() || name?.trim() || 'Преподаватель'
}

function previewOf(content: string) {
  const text = content
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').replace(/^[#\-•*\s]+/, '').trim())
    .filter((l) => l && !/^тема урока\s*:/i.test(l) && !/:$/.test(l))
    .join(' · ')
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

export async function listOwnNotes(ownerId: string): Promise<NoteListItem[]> {
  const rows = await db
    .select({
      id: lessonNote.id,
      title: lessonNote.title,
      content: lessonNote.content,
      updatedAt: lessonNote.updatedAt,
    })
    .from(lessonNote)
    .where(eq(lessonNote.ownerId, ownerId))
    .orderBy(desc(lessonNote.updatedAt))
    .limit(200)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    preview: previewOf(r.content),
    updatedAt: r.updatedAt.getTime(),
    ownerName: null,
  }))
}

export async function listSharedNotes(userId: string): Promise<NoteListItem[]> {
  const rows = await db
    .select({
      id: lessonNote.id,
      title: lessonNote.title,
      content: lessonNote.content,
      sharedAt: lessonNoteShare.sharedAt,
      ownerName: user.name,
      ownerUsername: user.username,
    })
    .from(lessonNoteShare)
    .innerJoin(lessonNote, eq(lessonNote.id, lessonNoteShare.noteId))
    .innerJoin(user, eq(user.id, lessonNote.ownerId))
    .where(eq(lessonNoteShare.userId, userId))
    .orderBy(desc(lessonNoteShare.sharedAt))
    .limit(200)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    preview: previewOf(r.content),
    updatedAt: r.sharedAt.getTime(),
    ownerName: displayName(r.ownerUsername, r.ownerName),
  }))
}

/** Конспект, если у зрителя есть доступ: он владелец или получатель. */
export async function getNoteForViewer(
  noteId: string,
  viewerId: string,
): Promise<{ note: NoteDetail; isOwner: boolean } | null> {
  const [row] = await db
    .select({
      id: lessonNote.id,
      title: lessonNote.title,
      content: lessonNote.content,
      createdAt: lessonNote.createdAt,
      updatedAt: lessonNote.updatedAt,
      ownerId: lessonNote.ownerId,
      ownerName: user.name,
      ownerUsername: user.username,
    })
    .from(lessonNote)
    .innerJoin(user, eq(user.id, lessonNote.ownerId))
    .where(eq(lessonNote.id, noteId))
    .limit(1)
  if (!row) return null

  const isOwner = row.ownerId === viewerId
  if (!isOwner) {
    const [share] = await db
      .select({ noteId: lessonNoteShare.noteId })
      .from(lessonNoteShare)
      .where(and(eq(lessonNoteShare.noteId, noteId), eq(lessonNoteShare.userId, viewerId)))
      .limit(1)
    if (!share) return null
  }

  return {
    isOwner,
    note: {
      id: row.id,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      ownerId: row.ownerId,
      ownerName: displayName(row.ownerUsername, row.ownerName),
    },
  }
}

/** Проверка и обрезка полей из тела запроса. null — данные некорректны. */
export function parseNoteInput(body: unknown): { title: string; content: string } | null {
  if (!body || typeof body !== 'object') return null
  const { title, content } = body as Record<string, unknown>
  if (typeof title !== 'string' || typeof content !== 'string') return null
  const t = title.trim().slice(0, MAX_NOTE_TITLE)
  const c = content.trim()
  if (!t || !c || c.length > MAX_NOTE_CONTENT) return null
  return { title: t, content: c }
}
