import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship } from '@/lib/db/schema'
import { notifyFriendsChanged } from '@/lib/chat/notify-friends-changed'

// POST /api/friends/accept — accept incoming request
export async function POST(req: NextRequest) {
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

  const [updated] = await db
    .update(friendship)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(and(eq(friendship.id, friendshipId), eq(friendship.addresseeId, userId)))
    .returning()

  if (!updated) {
    return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 })
  }

  // Отправитель заявки должен сразу увидеть нового друга и его presence.
  await notifyFriendsChanged(userId, updated.requesterId, 'accepted')

  return NextResponse.json({ friendship: updated })
}
