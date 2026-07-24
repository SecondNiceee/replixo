import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversationMember } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/read
//
// Сбрасывает счётчик непрочитанных и сдвигает маркер прочтения. lastReadAt
// никогда не откатывается назад (GREATEST) — тот же приём, что и в
// message_read у чата комнаты.
// ---------------------------------------------------------------------------
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  const { id: conversationId } = await params

  const updated = await db
    .update(conversationMember)
    .set({
      lastReadAt: sql`GREATEST(${conversationMember.lastReadAt}, now())`,
      unreadCount: 0,
    })
    .where(
      and(
        eq(conversationMember.conversationId, conversationId),
        eq(conversationMember.userId, userId),
      ),
    )
    .returning({ userId: conversationMember.userId })

  if (updated.length === 0) {
    return NextResponse.json({ error: 'Нет доступа к диалогу' }, { status: 403 })
  }

  return NextResponse.json({ ok: true })
}
