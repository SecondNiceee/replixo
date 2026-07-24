import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversation, conversationMember, directMessage, friendship, user } from '@/lib/db/schema'
import { directConversationId } from '@/lib/chat/conversation-id'

// ---------------------------------------------------------------------------
// GET /api/chat/conversations — список личных диалогов текущего пользователя
//
// Один запрос: моё членство → диалог → членство собеседника → его профиль →
// последнее сообщение (по денормализованному lastMessageId).
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  // Второе членство в том же диалоге — это собеседник.
  const peer = alias(conversationMember, 'peer')

  const rows = await db
    .select({
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      unreadCount: conversationMember.unreadCount,
      friendId: user.id,
      friendName: user.name,
      friendUsername: user.username,
      lastMessageText: directMessage.text,
      lastMessageSenderId: directMessage.senderId,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .innerJoin(
      peer,
      and(eq(peer.conversationId, conversation.id), ne(peer.userId, userId)),
    )
    .innerJoin(user, eq(user.id, peer.userId))
    .leftJoin(directMessage, eq(directMessage.id, conversation.lastMessageId))
    .where(eq(conversationMember.userId, userId))
    // NULLS LAST обязателен: в Postgres DESC ставит NULL первыми, из-за чего
    // только что созданные диалоги без сообщений висели бы выше активных.
    .orderBy(sql`${conversation.lastMessageAt} DESC NULLS LAST`)

  return NextResponse.json({ conversations: rows })
}

// ---------------------------------------------------------------------------
// POST /api/chat/conversations — открыть (или создать) диалог с другом
// Body: { friendId }
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => null)
  const friendId = typeof body?.friendId === 'string' ? body.friendId.trim() : ''
  if (!friendId) {
    return NextResponse.json({ error: 'friendId обязателен' }, { status: 400 })
  }
  if (friendId === userId) {
    return NextResponse.json({ error: 'Нельзя написать самому себе' }, { status: 400 })
  }

  // Право на чат = принятая дружба (в любом направлении).
  const [accepted] = await db
    .select({ id: friendship.id })
    .from(friendship)
    .where(
      and(
        eq(friendship.status, 'accepted'),
        or(
          and(eq(friendship.requesterId, userId), eq(friendship.addresseeId, friendId)),
          and(eq(friendship.requesterId, friendId), eq(friendship.addresseeId, userId)),
        ),
      ),
    )
    .limit(1)

  if (!accepted) {
    return NextResponse.json({ error: 'Вы не друзья' }, { status: 403 })
  }

  const conversationId = directConversationId(userId, friendId)

  await db
    .insert(conversation)
    .values({ id: conversationId, type: 'direct' })
    .onConflictDoNothing()

  await db
    .insert(conversationMember)
    .values([
      { conversationId, userId },
      { conversationId, userId: friendId },
    ])
    .onConflictDoNothing()

  return NextResponse.json({ conversationId })
}
