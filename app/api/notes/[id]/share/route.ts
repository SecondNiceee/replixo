import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { lessonNote, lessonNoteShare } from '@/lib/db/schema'
import { listFriends } from '@/lib/chat/friends'
import { createFriendNotification } from '@/lib/chat/notifications'

// POST /api/notes/[id]/share — Body: { userIds: string[] }.
// Отправить можно только своим друзьям; остальные id молча отбрасываются.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = session.user.id
  const { id } = await params

  const [note] = await db
    .select({ id: lessonNote.id })
    .from(lessonNote)
    .where(and(eq(lessonNote.id, id), eq(lessonNote.ownerId, ownerId)))
    .limit(1)
  if (!note) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  const body = await req.json().catch(() => null)
  const requested: unknown[] = Array.isArray(body?.userIds) ? body.userIds.slice(0, 50) : []

  const friendIds = new Set((await listFriends(ownerId)).map((f) => f.friendId))
  const recipients = [
    ...new Set(requested.filter((u): u is string => typeof u === 'string' && friendIds.has(u))),
  ]
  if (recipients.length === 0) {
    return NextResponse.json({ error: 'Выберите хотя бы одного друга' }, { status: 400 })
  }

  const now = new Date()
  await db
    .insert(lessonNoteShare)
    .values(recipients.map((userId) => ({ noteId: id, userId, sharedAt: now })))
    .onConflictDoUpdate({
      target: [lessonNoteShare.noteId, lessonNoteShare.userId],
      set: { sharedAt: now },
    })

  await Promise.all(recipients.map((r) => createFriendNotification(r, ownerId, 'note-shared')))

  return NextResponse.json({ shared: recipients.length })
}
