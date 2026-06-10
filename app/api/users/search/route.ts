import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'

// GET /api/users/search?username=... — find user by exact username
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const username = req.nextUrl.searchParams.get('username')?.trim() ?? ''
  if (!username) {
    return NextResponse.json({ error: 'username обязателен' }, { status: 400 })
  }

  const [found] = await db
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.username, username))
    .limit(1)

  if (!found) {
    return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 })
  }

  return NextResponse.json({ user: found })
}
