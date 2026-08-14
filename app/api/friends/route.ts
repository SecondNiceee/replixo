import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { eq, or, and } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'
import { fetchPresence } from '@/lib/chat/presence'

// GET /api/friends — accepted friends list
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const rows = await db
    .select({
      id: friendship.id,
      status: friendship.status,
      requesterId: friendship.requesterId,
      addresseeId: friendship.addresseeId,
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
    .innerJoin(
      user,
      or(
        and(eq(friendship.requesterId, userId), eq(user.id, friendship.addresseeId)),
        and(eq(friendship.addresseeId, userId), eq(user.id, friendship.requesterId)),
      ),
    )

  // Статусы кладём в тот же ответ, что и сам список: точки «в сети» должны быть
  // на первом кадре. Снапшот по websocket приходит только после подключения
  // сокета, поэтому раньше список секунду показывал всех «не в сети».
  //
  // Запрос к сокет-серверу ошибок не бросает и ограничен коротким таймаутом:
  // если он недоступен, вернётся пустой presence, а статусы доедут по websocket.
  const presence = await fetchPresence(rows.map((r) => r.friendId))

  return NextResponse.json(
    { friends: rows, presence },
    // Статусы живут секунды — кэшировать этот ответ нельзя ни на шаг.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
