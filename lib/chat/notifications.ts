// ---------------------------------------------------------------------------
// Запись уведомлений в БД. Только серверный код (Next-роуты).
//
// Порядок важен: сначала строка в БД, потом пуш по сокету. Уведомление —
// состояние пользователя, а не эффект соединения: если сокет-сервер лежит или
// получатель офлайн, событие всё равно должно дождаться его в центре
// уведомлений. Сокет-сервер поэтому ничего не создаёт, а лишь пушит уже
// сохранённую запись по её id.
//
// Провал записи НЕ должен ломать сам запрос: дружба уже изменена, а уведомление
// — надстройка. Поэтому ошибки глотаются с логом, а вызывающий роут получает
// null и просто рассылает realtime без notificationId.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { notification } from '@/lib/db/schema'

/** Виды уведомлений о дружбе. Совпадают с NotificationKind на клиенте. */
export type FriendNotificationKind = 'friend-request' | 'friend-accepted' | 'friend-declined'

/**
 * Создать (или обновить) уведомление для `recipientId` о действии `actorId`.
 *
 * Уникальный индекс на (userId, actorId, kind) делает повтор идемпотентным:
 * вторая заявка от того же человека не копит стопку, а поднимает существующую
 * запись наверх и снова помечает её непрочитанной. Ровно та же логика, что у
 * dedupeKey у тостов, только в БД.
 *
 * Возвращает id записи — его роут передаёт сокет-серверу, чтобы тот запушил
 * именно эту, уже сохранённую, запись. null — запись не удалась.
 */
export async function createFriendNotification(
  recipientId: string,
  actorId: string,
  kind: FriendNotificationKind,
): Promise<string | null> {
  // Уведомить самого себя невозможно по смыслу, но проверка дешёвая, а
  // «Вы принял вашу заявку» в центре уведомлений — дорогой баг.
  if (!recipientId || !actorId || recipientId === actorId) return null

  try {
    const [row] = await db
      .insert(notification)
      .values({
        id: randomUUID(),
        userId: recipientId,
        actorId,
        kind,
        readAt: null,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [notification.userId, notification.actorId, notification.kind],
        set: { createdAt: new Date(), readAt: null },
      })
      .returning({ id: notification.id })

    return row?.id ?? null
  } catch (e) {
    console.error('[notifications] создание не удалось:', (e as Error).message)
    return null
  }
}

/**
 * Убрать уведомление, потерявшее смысл.
 *
 * Нужно, когда инициатор отменяет своё же действие: заявку отозвали — значит в
 * центре уведомлений получателя не должно остаться «хочет добавить вас в
 * друзья», ведущего в пустые заявки.
 */
export async function deleteFriendNotification(
  recipientId: string,
  actorId: string,
  kind: FriendNotificationKind,
): Promise<void> {
  try {
    await db
      .delete(notification)
      .where(
        and(
          eq(notification.userId, recipientId),
          eq(notification.actorId, actorId),
          eq(notification.kind, kind),
        ),
      )
  } catch (e) {
    console.error('[notifications] удаление не удалось:', (e as Error).message)
  }
}

/** Сколько непрочитанных у пользователя. Отдаётся вместе со списком и после отметок. */
export async function countUnread(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(eq(notification.userId, userId), sql`${notification.readAt} IS NULL`))
    return row?.count ?? 0
  } catch (e) {
    console.error('[notifications] подсчёт непрочитанных не удался:', (e as Error).message)
    return 0
  }
}
