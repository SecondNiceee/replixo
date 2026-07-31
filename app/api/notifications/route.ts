import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { notification, user } from '@/lib/db/schema'
import { countUnread } from '@/lib/chat/notifications'

// ---------------------------------------------------------------------------
// Центр уведомлений: список + счётчик непрочитанных.
//
// Именно этот роут закрывает главный пробел прежней схемы: тост живёт секунды и
// только при живом websocket, а сюда пользователь приходит после перезагрузки
// или спустя день офлайна и видит всё, что произошло.
// ---------------------------------------------------------------------------

// Центр уведомлений — не журнал: глубже одного экрана никто не листает, а
// уникальный индекс (userId, actorId, kind) и так не даёт списку пухнуть.
const LIMIT = 30

// GET /api/notifications — свои уведомления, свежие сверху
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  // Имя актора берём джойном, а не из копии в строке уведомления: иначе после
  // переименования пользователя в центре осталась бы устаревшая подпись.
  const rows = await db
    .select({
      id: notification.id,
      kind: notification.kind,
      actorId: notification.actorId,
      actorName: user.name,
      actorUsername: user.username,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .innerJoin(user, eq(user.id, notification.actorId))
    .where(eq(notification.userId, userId))
    .orderBy(desc(notification.createdAt))
    .limit(LIMIT)

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorId: r.actorId,
    // username приоритетнее: в интерфейсе друзей везде показывается он.
    actorName: r.actorUsername?.trim() || r.actorName?.trim() || 'Пользователь',
    read: r.readAt !== null,
    createdAt: r.createdAt.getTime(),
  }))

  // Считаем отдельным запросом, а не по items: непрочитанное могло не попасть
  // в первые LIMIT записей, а бейдж должен показывать честное число.
  const unread = await countUnread(userId)

  return NextResponse.json({ items, unread })
}

// DELETE /api/notifications — удалить одно уведомление или очистить всё
export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id : ''

  // Условие на userId обязательно и при точечном удалении: id приходит от
  // клиента, и без него можно было бы стереть чужое уведомление.
  await db
    .delete(notification)
    .where(
      id
        ? and(eq(notification.userId, userId), eq(notification.id, id))
        : eq(notification.userId, userId),
    )

  return NextResponse.json({ ok: true, unread: await countUnread(userId) })
}
