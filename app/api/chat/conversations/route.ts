import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, or } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversation, conversationMember, friendship } from '@/lib/db/schema'
import { directConversationId } from '@/lib/chat/conversation-id'
import { listConversations } from '@/lib/chat/conversations'

// ---------------------------------------------------------------------------
// GET /api/chat/conversations — список личных диалогов текущего пользователя
//
// Сам запрос живёт в lib/chat/conversations: те же данные читает серверный
// рендер /profile, и форма ответа обязана совпадать.
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const conversations = await listConversations(session.user.id)
  return NextResponse.json({ conversations })
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
