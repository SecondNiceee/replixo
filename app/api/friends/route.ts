import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { listFriends } from '@/lib/chat/friends'
import { fetchPresence } from '@/lib/chat/presence'

// GET /api/friends — accepted friends list
//
// Сам запрос живёт в lib/chat/friends: те же данные читает серверный рендер
// /profile, и расходиться они не должны.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const friends = await listFriends(session.user.id)

  // Статусы кладём в тот же ответ, что и сам список: точки «в сети» должны быть
  // на первом кадре. Снапшот по websocket приходит только после подключения
  // сокета, поэтому раньше список секунду показывал всех «не в сети».
  //
  // Запрос к сокет-серверу ошибок не бросает и ограничен коротким таймаутом:
  // если он недоступен, вернётся presence с ok: false — по нему клиент покажет
  // «Подключение…», а не соврёт про оффлайн.
  const presence = await fetchPresence(friends.map((f) => f.friendId))

  return NextResponse.json(
    { friends, presence },
    // Статусы живут секунды — кэшировать этот ответ нельзя ни на шаг.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
