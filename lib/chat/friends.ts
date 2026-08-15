// ---------------------------------------------------------------------------
// Чтение списка друзей из БД.
//
// Вынесено из app/api/friends/route.ts, потому что тех же данных требует
// серверный рендер /profile: страница отдаёт список сразу в HTML, а роут
// остаётся для ревалидации на клиенте. Запрос обязан быть один и тот же —
// иначе SSR-кадр и первая ревалидация показывали бы разные списки.
// ---------------------------------------------------------------------------

import { and, eq, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'
import type { Friend } from '@/app/profile/types'

/** Принятые дружбы пользователя в любом направлении. */
export async function listFriends(userId: string): Promise<Friend[]> {
  return db
    .select({
      id: friendship.id,
      friendId: user.id,
      friendName: user.name,
      friendUsername: user.username,
    })
    .from(friendship)
    .where(
      and(
        eq(friendship.status, 'accepted'),
        or(eq(friendship.requesterId, userId), eq(friendship.addresseeId, userId)),
      ),
    )
    // Присоединяем «другого» участника: кто из двух столбцов дружбы им является,
    // зависит от того, кто отправлял заявку.
    .innerJoin(
      user,
      or(
        and(eq(friendship.requesterId, userId), eq(user.id, friendship.addresseeId)),
        and(eq(friendship.addresseeId, userId), eq(user.id, friendship.requesterId)),
      ),
    )
}
