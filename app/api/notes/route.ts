import { randomUUID } from 'crypto'
import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { lessonNote } from '@/lib/db/schema'
import { listOwnNotes, listSharedNotes, parseNoteInput } from '@/lib/notes'

// GET /api/notes — свои конспекты (для преподавателя) и присланные мне.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isTeacher = session.user.role === 'teacher'
  const [own, shared] = await Promise.all([
    isTeacher ? listOwnNotes(session.user.id) : Promise.resolve([]),
    listSharedNotes(session.user.id),
  ])
  return NextResponse.json({ own, shared, isTeacher })
}

// POST /api/notes — сохранить конспект. Body: { title, content, roomId? }.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.user.role !== 'teacher') {
    return NextResponse.json({ error: 'Только для преподавателей' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const input = parseNoteInput(body)
  if (!input) return NextResponse.json({ error: 'Пустой или слишком длинный конспект' }, { status: 400 })

  const roomId =
    typeof body?.roomId === 'string' && body.roomId.length <= 100 ? body.roomId : null

  const id = randomUUID()
  const now = new Date()
  await db.insert(lessonNote).values({
    id,
    ownerId: session.user.id,
    title: input.title,
    content: input.content,
    roomId,
    createdAt: now,
    updatedAt: now,
  })
  return NextResponse.json({ id })
}
