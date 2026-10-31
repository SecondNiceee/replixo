import { NO_INDEX } from "@/lib/seo"
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { lessonNote, lessonNoteShare } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getNoteForViewer } from '@/lib/notes'
import { verifyRoomNote } from '@/lib/notes-room-share'
import { NoteClient } from './note-client'

export const metadata: Metadata = {
  title: 'Конспект урока',
  description: 'Конспект урока, составленный в Replixo.',
  robots: NO_INDEX,
}

// Ссылка из чата комнаты несёт подпись владельца (?room=&sig=): по ней
// вошедший зритель получает постоянный доступ, как при обычной отправке.
async function grantRoomAccess(noteId: string, userId: string, room?: string, sig?: string) {
  if (!room || !sig || !verifyRoomNote(noteId, room, sig)) return
  const [note] = await db.select({ id: lessonNote.id }).from(lessonNote).where(eq(lessonNote.id, noteId)).limit(1)
  if (!note) return
  await db
    .insert(lessonNoteShare)
    .values({ noteId, userId, sharedAt: new Date() })
    .onConflictDoNothing()
}

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ room?: string; sig?: string }>
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/?auth=sign-in')

  const [{ id }, { room, sig }] = await Promise.all([params, searchParams])
  let result = await getNoteForViewer(id, session.user.id)
  if (!result && typeof room === 'string' && typeof sig === 'string') {
    await grantRoomAccess(id, session.user.id, room, sig)
    result = await getNoteForViewer(id, session.user.id)
  }
  if (!result) notFound()

  return (
    <main className="app-dark app-shell-surface min-h-dvh px-4 py-6 sm:py-10 print:bg-transparent print:p-0">
      <NoteClient note={result.note} isOwner={result.isOwner} />
    </main>
  )
}
