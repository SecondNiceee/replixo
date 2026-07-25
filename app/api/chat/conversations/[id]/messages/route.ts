import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, lt } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversationMember, directMessage } from '@/lib/db/schema'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/messages?before=<iso>&limit=50
//
// Курсорная пагинация по (conversationId, createdAt) — используется индекс
// dm_message_conv_createdAt_idx. Отдаём по возрастанию времени (для рендера),
// но выбираем всегда самые свежие относительно курсора.
// ---------------------------------------------------------------------------
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id
  const { id: conversationId } = await params

  // Membership — единственный способ получить доступ к истории.
  const [member] = await db
    .select({ userId: conversationMember.userId })
    .from(conversationMember)
    .where(
      and(
        eq(conversationMember.conversationId, conversationId),
        eq(conversationMember.userId, userId),
      ),
    )
    .limit(1)

  if (!member) {
    return NextResponse.json({ error: 'Нет доступа к диалогу' }, { status: 403 })
  }

  const url = new URL(req.url)
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT

  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? new Date(beforeRaw) : null
  const hasCursor = before !== null && !Number.isNaN(before.getTime())

  const rows = await db
    .select({
      id: directMessage.id,
      senderId: directMessage.senderId,
      text: directMessage.text,
      attachment: directMessage.attachment,
      createdAt: directMessage.createdAt,
    })
    .from(directMessage)
    .where(
      hasCursor
        ? and(
            eq(directMessage.conversationId, conversationId),
            lt(directMessage.createdAt, before as Date),
          )
        : eq(directMessage.conversationId, conversationId),
    )
    // Берём limit + 1, чтобы понять, есть ли что догружать выше.
    .orderBy(desc(directMessage.createdAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return NextResponse.json({ messages: page.reverse(), hasMore })
}
