import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { lessonNote } from '@/lib/db/schema'
import { isValidRoomId, roomNoteUrl } from '@/lib/notes-room-share'

// POST /api/notes/[id]/room-share — Body: { roomId: string }.
// Только владелец конспекта получает подписанную ссылку для чата комнаты.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const body = (await req.json().catch(() => null)) as { roomId?: unknown } | null
  const roomId = typeof body?.roomId === 'string' ? body.roomId : ''
  if (!isValidRoomId(roomId)) {
    return NextResponse.json({ error: 'Некорректная комната' }, { status: 400 })
  }

  const [note] = await db
    .select({ id: lessonNote.id, title: lessonNote.title })
    .from(lessonNote)
    .where(and(eq(lessonNote.id, id), eq(lessonNote.ownerId, session.user.id)))
    .limit(1)
  if (!note) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  return NextResponse.json({ url: roomNoteUrl(note.id, roomId), title: note.title })
}
