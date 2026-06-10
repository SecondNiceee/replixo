import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and, or } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship } from '@/lib/db/schema'

// DELETE /api/friends/remove — remove a friend
export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => null)
  const friendshipId = typeof body?.friendshipId === 'string' ? body.friendshipId : ''
  if (!friendshipId) {
    return NextResponse.json({ error: 'friendshipId обязателен' }, { status: 400 })
  }

  const [deleted] = await db
    .delete(friendship)
    .where(
      and(
        eq(friendship.id, friendshipId),
        or(eq(friendship.requesterId, userId), eq(friendship.addresseeId, userId)),
      ),
    )
    .returning()

  if (!deleted) {
    return NextResponse.json({ error: 'Не найдено' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
