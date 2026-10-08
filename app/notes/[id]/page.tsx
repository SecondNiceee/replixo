import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getNoteForViewer } from '@/lib/notes'
import { NoteClient } from './note-client'

export const metadata: Metadata = {
  title: 'Конспект урока — Replixo',
  description: 'Конспект урока, составленный в Replixo.',
}

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/?auth=sign-in')

  const { id } = await params
  const result = await getNoteForViewer(id, session.user.id)
  if (!result) notFound()

  return (
    <main className="app-dark app-shell-surface min-h-dvh px-4 py-6 sm:py-10 print:bg-transparent print:p-0">
      <NoteClient note={result.note} isOwner={result.isOwner} />
    </main>
  )
}
