import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { lessonNote } from '@/lib/db/schema'
import { getNoteForViewer, parseNoteInput } from '@/lib/notes'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const result = await getNoteForViewer(id, session.user.id)
  if (!result) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })
  return NextResponse.json(result)
}

// PATCH — редактировать может только владелец.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const input = parseNoteInput(await req.json().catch(() => null))
  if (!input) return NextResponse.json({ error: 'Пустой или слишком длинный конспект' }, { status: 400 })

  const updated = await db
    .update(lessonNote)
    .set({ title: input.title, content: input.content, updatedAt: new Date() })
    .where(and(eq(lessonNote.id, id), eq(lessonNote.ownerId, session.user.id)))
    .returning({ id: lessonNote.id })
  if (updated.length === 0) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const deleted = await db
    .delete(lessonNote)
    .where(and(eq(lessonNote.id, id), eq(lessonNote.ownerId, session.user.id)))
    .returning({ id: lessonNote.id })
  if (deleted.length === 0) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
