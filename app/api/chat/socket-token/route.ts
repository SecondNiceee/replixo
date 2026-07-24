import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// GET /api/chat/socket-token
//
// Отдаёт токен текущей сессии для handshake с namespace /dm на
// mediasoup-сервере. Сам cookie httpOnly и в JS недоступен, поэтому токен
// выдаём отдельным авторизованным запросом. Сервер проверяет его в таблице
// "session" напрямую в Postgres.
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json(
    { token: session.session.token, userId: session.user.id },
    // Токен не должен попасть ни в один кэш.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
