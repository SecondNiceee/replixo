import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { notification } from '@/lib/db/schema'
import { countUnread } from '@/lib/chat/notifications'

// POST /api/notifications/read — отметить прочитанным одно уведомление или все.
//
// Без id отмечаются все непрочитанные («Прочитать все» / открытие панели).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id : ''

  // isNull в условии — не оптимизация, а защита времени: без него повторный
  // «прочитать все» переписал бы readAt у давно прочитанных записей.
  await db
    .update(notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.readAt),
        ...(id ? [eq(notification.id, id)] : []),
      ),
    )

  return NextResponse.json({ ok: true, unread: await countUnread(userId) })
}
