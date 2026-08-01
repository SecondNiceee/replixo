import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq, and, or, inArray } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'
import { notifyFriendsChanged, originSocketIdFrom } from '@/lib/chat/notify-friends-changed'
import { createFriendNotification, deleteFriendNotification } from '@/lib/chat/notifications'
import { randomUUID } from 'crypto'

/**
 * Нарушение unique-индекса в Postgres.
 *
 * Drizzle оборачивает ошибку драйвера в DrizzleQueryError, поэтому code ищем и
 * по цепочке cause, а не только на самом объекте.
 */
function isUniqueViolation(e: unknown): boolean {
  for (let cur = e; cur; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: string }).code === '23505') return true
  }
  return false
}

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

  // Связь ищем в обе стороны и БЕЗ limit: на паре теоретически могут лежать две
  // строки (A→B и B→A), если когда-то заявки разошлись в обоих направлениях.
  // Их нужно увидеть все, иначе решение принимается по случайной из них.
  const existingRows = await db
    .select({
      id: friendship.id,
      requesterId: friendship.requesterId,
      status: friendship.status,
    })
    .from(friendship)
    .where(
      or(
        and(eq(friendship.requesterId, requesterId), eq(friendship.addresseeId, addressee.id)),
        and(eq(friendship.requesterId, addressee.id), eq(friendship.addresseeId, requesterId)),
      ),
    )

  if (existingRows.some((r) => r.status === 'accepted')) {
    return NextResponse.json({ error: 'Вы уже друзья' }, { status: 409 })
  }

  const pending = existingRows.find((r) => r.status === 'pending')
  if (pending) {
    return NextResponse.json(
      {
        error:
          pending.requesterId === requesterId
            ? 'Заявка уже отправлена'
            : 'Этот пользователь уже отправил вам заявку',
      },
      { status: 409 },
    )
  }

  // Дальше остались только отклонённые строки. Новую вставлять нельзя: на
  // (requesterId, addresseeId) висит unique-индекс, и в прошлой версии повторная
  // заявка после отказа падала с 23505 → 500. Поэтому переиспользуем
  // существующую строку, разворачивая направление под нового инициатора, а
  // возможные дубликаты по паре сносим, чтобы связь снова описывалась одной
  // записью.
  let created: typeof friendship.$inferSelect | undefined
  const now = new Date()

  try {
    if (existingRows.length > 0) {
      const [keep, ...duplicates] = existingRows
      created = await db.transaction(async (tx) => {
        if (duplicates.length > 0) {
          await tx.delete(friendship).where(
            inArray(
              friendship.id,
              duplicates.map((d) => d.id),
            ),
          )
        }
        const [row] = await tx
          .update(friendship)
          .set({
            requesterId,
            addresseeId: addressee.id,
            status: 'pending',
            // createdAt сбрасываем: для получателя это новая заявка, и списки
            // сортируются по нему.
            createdAt: now,
            updatedAt: now,
          })
          .where(eq(friendship.id, keep.id))
          .returning()
        return row
      })
    } else {
      const [row] = await db
        .insert(friendship)
        .values({
          id: randomUUID(),
          requesterId,
          addresseeId: addressee.id,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      created = row
    }
  } catch (e) {
    // Гонка двух одновременных заявок по одной паре: одна выиграла, вторая
    // получает осмысленный 409 вместо 500.
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: 'Заявка уже отправлена' }, { status: 409 })
    }
    throw e
  }

  if (!created) {
    return NextResponse.json({ error: 'Не удалось создать заявку' }, { status: 500 })
  }

  // Прошлый отказ по этой паре больше не актуален: заявка снова висит, и
  // «X отклонил вашу заявку» в центре уведомлений только путало бы.
  await Promise.all([
    deleteFriendNotification(requesterId, addressee.id, 'friend-declined'),
    deleteFriendNotification(addressee.id, requesterId, 'friend-declined'),
  ])

  // Сначала запись в БД, потом пуш: адресат может быть офлайн, и тогда узнает о
  // заявке в центре уведомлений при следующем входе.
  const notificationId = await createFriendNotification(
    addressee.id,
    requesterId,
    'friend-request',
  )

  // Адресат должен увидеть заявку сразу. Уведомляем сокет-сервер сами, а не
  // руками клиента: иначе realtime зависел бы от наличия у отправителя живого
  // websocket.
  const notified = await notifyFriendsChanged(
    requesterId,
    addressee.id,
    'requested',
    notificationId,
    originSocketIdFrom(req.headers),
  )

  return NextResponse.json({ friendship: created, notified }, { status: 201 })
}
