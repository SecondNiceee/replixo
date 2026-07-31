import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship } from '@/lib/db/schema'
import { notifyFriendsChanged } from '@/lib/chat/notify-friends-changed'
import { deleteFriendNotification } from '@/lib/chat/notifications'

// DELETE /api/friends/cancel — cancel an outgoing pending request
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
        eq(friendship.requesterId, userId),
        eq(friendship.status, 'pending'),
      ),
    )
    .returning()

  if (!deleted) {
    return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 })
  }

  // Заявку отозвали — уведомление о ней стало ложью и ведёт в пустые заявки.
  // Удаляем, а не помечаем прочитанным: события «этого больше нет» в центре
  // уведомлений быть не должно.
  await deleteFriendNotification(deleted.addresseeId, userId, 'friend-request')

  // Строка удалена, поэтому статуса в БД уже нет — причину сообщаем явно.
  const notified = await notifyFriendsChanged(userId, deleted.addresseeId, 'cancelled')

  return NextResponse.json({ ok: true, peerId: deleted.addresseeId, notified })
}
