import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and, or } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'
import { notifyFriendsChanged } from '@/lib/chat/notify-friends-changed'
import { randomUUID } from 'crypto'

// POST /api/friends/request — send friend request by username
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const requesterId = session.user.id

  const body = await req.json().catch(() => null)
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  if (!username) {
    return NextResponse.json({ error: 'username обязателен' }, { status: 400 })
  }

  // Find addressee
  const [addressee] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username))
    .limit(1)

  if (!addressee) {
    return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 })
  }
  if (addressee.id === requesterId) {
    return NextResponse.json({ error: 'Нельзя добавить самого себя' }, { status: 400 })
  }

  // Check for existing friendship in either direction
  const [existing] = await db
    .select({ id: friendship.id, status: friendship.status })
    .from(friendship)
    .where(
      or(
        and(eq(friendship.requesterId, requesterId), eq(friendship.addresseeId, addressee.id)),
        and(eq(friendship.requesterId, addressee.id), eq(friendship.addresseeId, requesterId)),
      ),
    )
    .limit(1)

  if (existing) {
    if (existing.status === 'accepted') {
      return NextResponse.json({ error: 'Вы уже друзья' }, { status: 409 })
    }
    if (existing.status === 'pending') {
      return NextResponse.json({ error: 'Заявка уже отправлена' }, { status: 409 })
    }
  }

  const [created] = await db
    .insert(friendship)
    .values({
      id: randomUUID(),
      requesterId,
      addresseeId: addressee.id,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()

  // Адресат должен увидеть заявку сразу. Уведомляем сокет-сервер сами, а не
  // руками клиента: иначе realtime зависел бы от наличия у отправителя живого
  // websocket.
  await notifyFriendsChanged(requesterId, addressee.id, 'requested')

  return NextResponse.json({ friendship: created }, { status: 201 })
}
